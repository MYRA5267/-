import { DomainError, assertTouched, withAdmin, withUser } from './db';
import { hashOf, actorContext } from './content';
import { idempotencyKey } from './crypto';
import { track } from './audit';
import { canAutoPublish } from './connectors';
import type { Platform, Schedule } from './types';

/**
 * Календарь и очередь.
 *
 * В очередь попадает только одобренный снимок. Перед постановкой сверяем
 * хэш: если текст поправили после одобрения, публиковать нечего.
 * Время хранится в UTC, показывается в поясе проекта.
 */

type ScheduleRow = {
  id: string;
  project_id: string;
  variant_id: string;
  platform: Platform;
  scheduled_at: string;
  timezone: string;
  status: Schedule['status'];
  title: string;
  accent: string;
  external_url: string | null;
  error_message: string | null;
};

const toSchedule = (r: ScheduleRow): Schedule => ({
  id: r.id,
  projectId: r.project_id,
  variantId: r.variant_id,
  platform: r.platform,
  scheduledAt: r.scheduled_at,
  timezone: r.timezone,
  status: r.status,
  title: r.title,
  accent: r.accent,
  externalUrl: r.external_url,
  errorMessage: r.error_message,
});

const CALENDAR_SELECT = `
  select s.id, s.project_id, s.variant_id, v.platform, s.scheduled_at, s.timezone,
         s.status, c.title, p.accent,
         pub.external_url,
         (select j.error_message from pulse.publish_jobs j
           where j.schedule_id = s.id order by j.attempt desc limit 1) as error_message
    from pulse.schedules s
    join pulse.platform_variants v on v.id = s.variant_id
    join pulse.content_items c on c.id = v.content_item_id
    join pulse.projects p on p.id = s.project_id
    left join pulse.publications pub on pub.schedule_id = s.id`;

export async function listSchedules(
  tgId: number | string,
  range: { from: string; to: string; projectId?: string },
): Promise<Schedule[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<ScheduleRow>(
      `${CALENDAR_SELECT}
        where s.scheduled_at >= $1 and s.scheduled_at < $2
          and ($3::uuid is null or s.project_id = $3)
        order by s.scheduled_at`,
      [range.from, range.to, range.projectId ?? null],
    );
    return rows.map(toSchedule);
  });
}

/** Постановка одобренной версии на конкретное время. */
export async function schedulePublication(
  tgId: number | string,
  input: { variantId: string; scheduledAt: string; socialAccountId?: string },
): Promise<Schedule> {
  const when = new Date(input.scheduledAt);
  if (Number.isNaN(when.getTime())) throw new DomainError('BAD_TIME');

  const result = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      project_id: string;
      platform: Platform;
      body: string;
      first_hook: string;
      cta: string;
      status: string;
      approved_hash: string | null;
      timezone: string;
      title: string;
    }>(
      `select v.id, c.project_id, v.platform, v.body, v.first_hook, v.cta,
              v.status, v.approved_hash, p.timezone, c.title
         from pulse.platform_variants v
         join pulse.content_items c on c.id = v.content_item_id
         join pulse.projects p on p.id = c.project_id
        where v.id = $1`,
      [input.variantId],
    );
    const variant = rows[0];
    if (!variant) throw new DomainError('VARIANT_NOT_FOUND', 404);

    // ничего не публикуется без явного одобрения человека — правило 1
    if (variant.status !== 'APPROVED' || !variant.approved_hash) {
      throw new DomainError('NOT_APPROVED', 409);
    }
    const current = hashOf({
      body: variant.body,
      firstHook: variant.first_hook,
      cta: variant.cta,
    });
    if (current !== variant.approved_hash) throw new DomainError('CONTENT_CHANGED', 409);

    const accountId = input.socialAccountId ?? (await pickAccount(client, variant.project_id, variant.platform));
    if (!accountId && canAutoPublish(variant.platform)) {
      throw new DomainError('NO_ACCOUNT', 409);
    }

    // одну и ту же версию дважды в очередь не ставим
    const { rowCount: duplicate } = await client.query(
      `select 1 from pulse.schedules
        where variant_id = $1 and status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED')`,
      [input.variantId],
    );
    if (duplicate) throw new DomainError('ALREADY_SCHEDULED', 409);

    const { rows: created } = await client.query<{ id: string }>(
      `insert into pulse.schedules
         (project_id, variant_id, social_account_id, scheduled_at, timezone,
          approved_hash, created_by, status)
       values ($1, $2, $3, $4, $5, $6, pulse.me(), 'SCHEDULED')
       returning id`,
      [
        variant.project_id,
        input.variantId,
        accountId,
        when.toISOString(),
        variant.timezone,
        variant.approved_hash,
      ],
    );
    if (!created[0]) throw new DomainError('FORBIDDEN', 403);

    await client.query(
      `update pulse.platform_variants set status = 'SCHEDULED', updated_at = now() where id = $1`,
      [input.variantId],
    );
    await client.query(
      `update pulse.content_items set status = 'SCHEDULED', updated_at = now()
        where id = (select content_item_id from pulse.platform_variants where id = $1)`,
      [input.variantId],
    );

    const { rows: full } = await client.query<ScheduleRow>(
      `${CALENDAR_SELECT} where s.id = $1`,
      [created[0].id],
    );
    return {
      schedule: toSchedule(full[0]),
      projectId: variant.project_id,
      approvedHash: variant.approved_hash,
    };
  });

  // задача очереди создаётся привилегированным путём: у приложения нет
  // insert на publish_jobs, и это правильно — очередь принадлежит worker'у
  await withAdmin(async (client) => {
    await client.query(
      `insert into pulse.publish_jobs (schedule_id, idempotency_key, status, next_retry_at)
       values ($1, $2, 'PENDING', $3)
       on conflict (idempotency_key) do nothing`,
      // ключ считается от одобренного снимка: та же публикация после
      // сетевой ошибки попадёт в тот же ключ и не уйдёт дважды
      [
        result.schedule.id,
        idempotencyKey(result.schedule.id, result.approvedHash),
        when.toISOString(),
      ],
    );
    const ctx = await actorContext(client, tgId, result.projectId);
    if (ctx) {
      await track(client, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: 'publication_scheduled',
        props: { platform: result.schedule.platform, at: when.toISOString() },
      });
    }
  });

  return result.schedule;
}

/** Перенос времени — drag-and-drop в календаре. */
export async function reschedule(
  tgId: number | string,
  scheduleId: string,
  scheduledAt: string,
): Promise<Schedule> {
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) throw new DomainError('BAD_TIME');

  const schedule = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      'select status from pulse.schedules where id = $1',
      [scheduleId],
    );
    if (!rows[0]) throw new DomainError('SCHEDULE_NOT_FOUND', 404);
    if (rows[0].status !== 'SCHEDULED') throw new DomainError('ALREADY_SENT', 409);

    const { rowCount } = await client.query(
      'update pulse.schedules set scheduled_at = $2 where id = $1',
      [scheduleId, when.toISOString()],
    );
    assertTouched(rowCount);

    const { rows: full } = await client.query<ScheduleRow>(`${CALENDAR_SELECT} where s.id = $1`, [
      scheduleId,
    ]);
    return toSchedule(full[0]);
  });

  await withAdmin(async (client) => {
    await client.query(
      `update pulse.publish_jobs set next_retry_at = $2, updated_at = now()
        where schedule_id = $1 and status in ('PENDING', 'FAILED_RETRYABLE')`,
      [scheduleId, when.toISOString()],
    );
  });

  return schedule;
}

/** Отмена. Забранную в работу задачу уже не останавливаем — она в полёте. */
export async function cancelSchedule(tgId: number | string, scheduleId: string): Promise<void> {
  await withUser(tgId, async (client) => {
    const { rowCount } = await client.query(
      `update pulse.schedules set status = 'APPROVED'
        where id = $1 and status = 'SCHEDULED'`,
      [scheduleId],
    );
    if (!rowCount) throw new DomainError('ALREADY_SENT', 409);

    await client.query(
      `update pulse.platform_variants set status = 'APPROVED', updated_at = now()
        where id = (select variant_id from pulse.schedules where id = $1)`,
      [scheduleId],
    );
  });

  await withAdmin(async (client) => {
    await client.query(
      `update pulse.publish_jobs set status = 'FAILED_FINAL', error_code = 'CANCELLED',
              error_message = 'Отменено человеком', updated_at = now()
        where schedule_id = $1 and status in ('PENDING', 'FAILED_RETRYABLE')`,
      [scheduleId],
    );
  });
}

/** Конфликты времени: две публикации в один канал слишком близко. */
export async function findConflicts(
  tgId: number | string,
  input: { projectId: string; scheduledAt: string; windowMinutes?: number },
): Promise<Schedule[]> {
  const window = (input.windowMinutes ?? 30) * 60_000;
  const at = new Date(input.scheduledAt).getTime();

  return withUser(tgId, async (client) => {
    const { rows } = await client.query<ScheduleRow>(
      `${CALENDAR_SELECT}
        where s.project_id = $1 and s.status = 'SCHEDULED'
          and s.scheduled_at between $2 and $3`,
      [input.projectId, new Date(at - window).toISOString(), new Date(at + window).toISOString()],
    );
    return rows.map(toSchedule);
  });
}

async function pickAccount(
  client: import('pg').PoolClient,
  projectId: string,
  platform: Platform,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `select id from pulse.social_accounts
      where project_id = $1 and platform = $2 and status in ('connected', 'export_only')
      order by status = 'connected' desc
      limit 1`,
    [projectId, platform],
  );
  return rows[0]?.id ?? null;
}
