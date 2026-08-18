import type { PoolClient } from 'pg';
import { withAdmin } from './db';
import { contentHash, idempotencyKey } from './crypto';
import { decryptSecret } from './crypto';
import { connectorFor } from './connectors';
import { MAX_ATTEMPTS, retryDelayMs, type PublishAsset } from './connectors/types';
import { escapeHtml, notify } from './connectors/telegram';
import { logAction, track } from './audit';
import type { ErrorStatus, Platform } from './types';

/**
 * Worker очереди.
 *
 * Работает привилегированным путём: читает токены, пишет публикации и
 * журнал — того, чего роли authenticated не дают. Живёт отдельно от
 * экранов и вызывается по расписанию.
 *
 * Правила, которые здесь важнее скорости:
 * — перед отправкой сверяем одобренный снимок, срок токена и лимиты;
 * — временная ошибка повторяется с растущей задержкой;
 * — постоянная останавливает задачу и уведомляет владельца;
 * — повторный запрос после сетевой ошибки не создаёт второй пост.
 */

const STALE_LOCK_MS = 10 * 60_000;

export type TickResult = {
  claimed: number;
  published: number;
  failed: number;
  retried: number;
};

type Claimed = {
  jobId: string;
  scheduleId: string;
  attempt: number;
  idempotencyKey: string;
  projectId: string;
  workspaceId: string;
  variantId: string;
  platform: Platform;
  body: string;
  firstHook: string;
  cta: string;
  metadata: Record<string, unknown>;
  approvedHash: string;
  title: string;
  accountId: string | null;
  externalAccountId: string | null;
  tokenCiphertext: string | null;
  tokenExpiresAt: string | null;
  createdByTgId: string | null;
};

/** Один проход очереди. Вызывается cron'ом или скриптом worker'а. */
export async function tick(limit = 10): Promise<TickResult> {
  await releaseStaleLocks();
  await enqueueOrphans();

  const jobs = await claim(limit);
  const result: TickResult = { claimed: jobs.length, published: 0, failed: 0, retried: 0 };

  for (const job of jobs) {
    const outcome = await run(job);
    if (outcome === 'published') result.published += 1;
    else if (outcome === 'retry') result.retried += 1;
    else result.failed += 1;
  }

  return result;
}

/** Задача, которую забрал упавший процесс, не должна висеть вечно. */
async function releaseStaleLocks(): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `update pulse.publish_jobs
          set status = 'FAILED_RETRYABLE', locked_at = null,
              error_code = coalesce(error_code, 'STALE_LOCK'),
              next_retry_at = now(), updated_at = now()
        where status = 'RUNNING' and locked_at < now() - ($1 || ' milliseconds')::interval`,
      [String(STALE_LOCK_MS)],
    );
    await client.query(
      `update pulse.schedules set status = 'SCHEDULED'
        where status = 'PUBLISHING'
          and id in (select schedule_id from pulse.publish_jobs
                      where status = 'FAILED_RETRYABLE' and error_code = 'STALE_LOCK')`,
    );
  });
}

/**
 * Расписание и задача очереди пишутся разными транзакциями: календарь —
 * от имени человека, под RLS, а очередь — привилегированным путём, потому
 * что insert на publish_jobs приложению не выдан. Между ними есть зазор:
 * упавший процесс оставит запись в календаре без задачи, и публикация
 * не уйдёт никогда, молча.
 *
 * Поэтому очередь чинит себя сама: всё, чему пора и у чего нет задачи,
 * получает её здесь. Ключ идемпотентности тот же, что и при постановке,
 * так что задача не задвоится, даже если та транзакция всё-таки дошла.
 */
async function enqueueOrphans(): Promise<void> {
  await withAdmin(async (client) => {
    const { rows } = await client.query<{ id: string; approved_hash: string | null }>(
      `select s.id, s.approved_hash
         from pulse.schedules s
    left join pulse.publish_jobs j on j.schedule_id = s.id
        where s.status = 'SCHEDULED' and s.scheduled_at <= now() and j.id is null
        limit 100`,
    );
    for (const row of rows) {
      await client.query(
        `insert into pulse.publish_jobs (schedule_id, idempotency_key, status, next_retry_at)
         values ($1, $2, 'PENDING', now())
         on conflict (idempotency_key) do nothing`,
        [row.id, idempotencyKey(row.id, row.approved_hash ?? '')],
      );
    }
  });
}

/**
 * Забираем задачи, до которых дошло время. `for update skip locked` —
 * чтобы два worker'а не взяли одну задачу и не отправили пост дважды.
 */
async function claim(limit: number): Promise<Claimed[]> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ id: string; schedule_id: string }>(
      `select j.id, j.schedule_id
         from pulse.publish_jobs j
         join pulse.schedules s on s.id = j.schedule_id
        where j.status in ('PENDING', 'FAILED_RETRYABLE')
          and s.status = 'SCHEDULED'
          and coalesce(j.next_retry_at, s.scheduled_at) <= now()
        order by coalesce(j.next_retry_at, s.scheduled_at)
        limit $1
        for update of j skip locked`,
      [limit],
    );
    if (!rows.length) return [];

    const ids = rows.map((r) => r.id);
    await client.query(
      `update pulse.publish_jobs
          set status = 'RUNNING', attempt = attempt + 1, locked_at = now(), updated_at = now()
        where id = any($1)`,
      [ids],
    );
    await client.query(
      `update pulse.schedules set status = 'PUBLISHING' where id = any($1)`,
      [rows.map((r) => r.schedule_id)],
    );

    const { rows: full } = await client.query<Record<string, never>>(
      `select j.id as job_id, j.attempt, j.idempotency_key,
              s.id as schedule_id, s.project_id, s.approved_hash,
              p.workspace_id,
              v.id as variant_id, v.platform, v.body, v.first_hook, v.cta, v.metadata_json,
              c.title,
              a.id as account_id, a.external_account_id, a.token_ciphertext, a.token_expires_at,
              u.tg_id as created_by_tg_id
         from pulse.publish_jobs j
         join pulse.schedules s on s.id = j.schedule_id
         join pulse.projects p on p.id = s.project_id
         join pulse.platform_variants v on v.id = s.variant_id
         join pulse.content_items c on c.id = v.content_item_id
         left join pulse.social_accounts a on a.id = s.social_account_id
         left join pulse.users u on u.id = s.created_by
        where j.id = any($1)`,
      [ids],
    );

    return (full as unknown as Array<Record<string, string | number | null>>).map((r) => ({
      jobId: String(r.job_id),
      scheduleId: String(r.schedule_id),
      attempt: Number(r.attempt),
      idempotencyKey: String(r.idempotency_key),
      projectId: String(r.project_id),
      workspaceId: String(r.workspace_id),
      variantId: String(r.variant_id),
      platform: r.platform as Platform,
      body: String(r.body ?? ''),
      firstHook: String(r.first_hook ?? ''),
      cta: String(r.cta ?? ''),
      metadata: (r.metadata_json as unknown as Record<string, unknown>) ?? {},
      approvedHash: String(r.approved_hash),
      title: String(r.title ?? ''),
      accountId: r.account_id ? String(r.account_id) : null,
      externalAccountId: r.external_account_id ? String(r.external_account_id) : null,
      tokenCiphertext: r.token_ciphertext ? String(r.token_ciphertext) : null,
      tokenExpiresAt: r.token_expires_at ? String(r.token_expires_at) : null,
      createdByTgId: r.created_by_tg_id ? String(r.created_by_tg_id) : null,
    }));
  });
}

async function run(job: Claimed): Promise<'published' | 'retry' | 'failed'> {
  // 0. Не отправлено ли уже. Ключ идемпотентности защищает строку в базе, но не
  // сам пост: если worker упал между отправкой и отметкой «готово», задача
  // честно вернётся в очередь — и без этой проверки подписчики увидят второй
  // пост. Площадки удаляют его не всегда и не везде, поэтому дешевле не слать.
  const already = await publicationOf(job.scheduleId);
  if (already) {
    await success(job, already.external_post_id ?? '', already.external_url, already.published_at);
    return 'published';
  }

  // 1. Одобренный снимок. Текст мог измениться между постановкой и отправкой.
  const current = contentHash({ body: job.body, firstHook: job.firstHook, cta: job.cta });
  if (current !== job.approvedHash) {
    await finalFailure(job, 'PLATFORM_REJECTED', 'CONTENT_CHANGED', 'Текст изменился после одобрения');
    return 'failed';
  }

  // 2. Куда отправлять
  if (!job.externalAccountId) {
    await finalFailure(job, 'AUTH_REQUIRED', 'NO_ACCOUNT', 'Площадка не подключена к проекту');
    return 'failed';
  }

  // 3. Срок токена
  if (job.tokenExpiresAt && new Date(job.tokenExpiresAt) < new Date()) {
    await finalFailure(job, 'AUTH_REQUIRED', 'TOKEN_EXPIRED', 'Токен площадки истёк — нужно переподключение');
    return 'failed';
  }

  let token: string | null = null;
  if (job.tokenCiphertext) {
    try {
      token = decryptSecret(job.tokenCiphertext);
    } catch {
      await finalFailure(job, 'AUTH_REQUIRED', 'TOKEN_UNREADABLE', 'Токен не расшифровывается');
      return 'failed';
    }
  }

  const assets = await readAssets(job.variantId);

  const result = await connectorFor(job.platform).publish({
    platform: job.platform,
    externalAccountId: job.externalAccountId,
    token,
    firstHook: job.firstHook,
    body: job.body,
    cta: job.cta,
    assets,
    metadata: job.metadata,
    idempotencyKey: job.idempotencyKey,
  });

  if (result.ok) {
    await success(job, result.externalPostId, result.externalUrl, result.publishedAt);
    return 'published';
  }

  const retryable =
    (result.status === 'FAILED_RETRYABLE' || result.status === 'RATE_LIMITED') &&
    job.attempt < MAX_ATTEMPTS;

  if (retryable) {
    await scheduleRetry(job, result.status, result.code, result.message, result.retryAfterMs);
    return 'retry';
  }

  await finalFailure(job, result.status, result.code, result.message);
  return 'failed';
}

/** Уже опубликованное по этому расписанию, если есть. */
async function publicationOf(scheduleId: string): Promise<{
  external_post_id: string | null;
  external_url: string | null;
  published_at: string;
} | null> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{
      external_post_id: string | null;
      external_url: string | null;
      published_at: string;
    }>(
      `select external_post_id, external_url, published_at
         from pulse.publications where schedule_id = $1`,
      [scheduleId],
    );
    return rows[0] ?? null;
  });
}

async function success(
  job: Claimed,
  externalPostId: string,
  externalUrl: string | null,
  publishedAt: string,
): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `insert into pulse.publications
         (project_id, schedule_id, platform, external_post_id, external_url,
          published_at, payload_snapshot_json)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (schedule_id) do nothing`,
      [
        job.projectId,
        job.scheduleId,
        job.platform,
        externalPostId,
        externalUrl,
        publishedAt,
        JSON.stringify({
          firstHook: job.firstHook,
          body: job.body,
          cta: job.cta,
          approvedHash: job.approvedHash,
        }),
      ],
    );

    await client.query(
      `update pulse.publish_jobs
          set status = 'DONE', locked_at = null, error_code = null,
              error_message = null, updated_at = now()
        where id = $1`,
      [job.jobId],
    );
    await client.query(`update pulse.schedules set status = 'PUBLISHED' where id = $1`, [
      job.scheduleId,
    ]);
    await client.query(
      `update pulse.platform_variants set status = 'PUBLISHED', updated_at = now() where id = $1`,
      [job.variantId],
    );
    await client.query(
      `update pulse.content_items
          set status = 'PUBLISHED', idea_state = 'used', updated_at = now()
        where id = (select content_item_id from pulse.platform_variants where id = $1)`,
      [job.variantId],
    );

    await logAction(client, {
      workspaceId: job.workspaceId,
      actorId: null,
      action: 'publication.succeeded',
      entityType: 'schedule',
      entityId: job.scheduleId,
      after: { externalPostId, externalUrl },
    });
    await track(client, {
      workspaceId: job.workspaceId,
      userId: null,
      name: 'publication_succeeded',
      props: { platform: job.platform },
    });
  });

  if (job.createdByTgId) {
    const link = externalUrl ? `\n${externalUrl}` : '';
    await notify(job.createdByTgId, `<b>Опубликовано</b>\n«${escapeHtml(job.title)}»${link}`);
  }
}

async function scheduleRetry(
  job: Claimed,
  status: ErrorStatus,
  code: string,
  message: string,
  retryAfterMs: number | null,
): Promise<void> {
  const delay = retryAfterMs ?? retryDelayMs(job.attempt);
  const next = new Date(Date.now() + delay).toISOString();

  await withAdmin(async (client) => {
    await client.query(
      `update pulse.publish_jobs
          set status = 'FAILED_RETRYABLE', locked_at = null,
              error_code = $2, error_message = $3, next_retry_at = $4, updated_at = now()
        where id = $1`,
      [job.jobId, code, message, next],
    );
    // публикация остаётся в очереди: это не отказ, а пауза
    await client.query(`update pulse.schedules set status = 'SCHEDULED' where id = $1`, [
      job.scheduleId,
    ]);
    await client.query(
      `update pulse.platform_variants set status = $2, updated_at = now() where id = $1`,
      [job.variantId, status],
    );
  });
}

async function finalFailure(
  job: Claimed,
  status: ErrorStatus,
  code: string,
  message: string,
): Promise<void> {
  await withAdmin(async (client) => {
    await client.query(
      `update pulse.publish_jobs
          set status = 'FAILED_FINAL', locked_at = null,
              error_code = $2, error_message = $3, next_retry_at = null, updated_at = now()
        where id = $1`,
      [job.jobId, code, message],
    );
    await client.query(`update pulse.schedules set status = $2 where id = $1`, [
      job.scheduleId,
      status,
    ]);
    await client.query(
      `update pulse.platform_variants set status = $2, updated_at = now() where id = $1`,
      [job.variantId, status],
    );

    await logAction(client, {
      workspaceId: job.workspaceId,
      actorId: null,
      action: 'publication.failed',
      entityType: 'schedule',
      entityId: job.scheduleId,
      after: { code, message },
    });
    await track(client, {
      workspaceId: job.workspaceId,
      userId: null,
      name: 'publication_failed',
      props: { platform: job.platform, code },
    });
  });

  if (job.createdByTgId) {
    await notify(
      job.createdByTgId,
      `<b>Публикация остановлена</b>\n«${escapeHtml(job.title)}»\n${escapeHtml(message)}`,
    );
  }
}

async function readAssets(variantId: string): Promise<PublishAsset[]> {
  return withAdmin(async (client: PoolClient) => {
    const { rows } = await client.query<{ kind: PublishAsset['kind']; storage_url: string; mime_type: string | null }>(
      `select a.kind, a.storage_url, a.mime_type
         from pulse.assets a
         join pulse.platform_variants v on v.content_item_id = a.content_item_id
        where v.id = $1
        order by a.created_at
        limit 10`,
      [variantId],
    );
    return rows.map((r) => ({ kind: r.kind, url: r.storage_url, mimeType: r.mime_type }));
  });
}
