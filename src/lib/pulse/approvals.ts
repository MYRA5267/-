import { DomainError, assertTouched, withAdmin, withUser } from './db';
import { hashOf, actorContext, qualityOf } from './content';
import { hasBlockers, type QualityFinding } from './ai/quality';
import { logAction, track } from './audit';
import { escapeHtml, notify } from './connectors/telegram';
import type { Approval, Platform } from './types';

/**
 * Согласование.
 *
 * Одобряется не «материал вообще», а конкретный снимок текста: хэш пишется
 * в момент запроса и проверяется в момент решения. Если между этим текст
 * поправили — одобрять уже нечего, запрос устарел.
 */

type ApprovalRow = {
  id: string;
  project_id: string;
  target_type: 'variant' | 'content_item';
  target_id: string;
  decision: Approval['decision'];
  comment: string;
  created_at: string;
  decided_at: string | null;
  content_item_id?: string;
  platform?: Platform;
  first_hook?: string;
  body?: string;
  previous_body?: string | null;
};

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  projectId: r.project_id,
  targetType: r.target_type,
  targetId: r.target_id,
  decision: r.decision,
  comment: r.comment,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  contentItemId: r.content_item_id ?? null,
  preview:
    r.platform && r.body !== undefined
      ? {
          platform: r.platform,
          firstHook: r.first_hook ?? '',
          body: r.body,
          previousBody: r.previous_body ?? null,
        }
      : undefined,
});

export async function listPending(
  tgId: number | string,
  projectId?: string,
): Promise<Approval[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<ApprovalRow>(
      `select a.id, a.project_id, a.target_type, a.target_id, a.decision,
              a.comment, a.created_at, a.decided_at,
              v.content_item_id, v.platform, v.first_hook, v.body,
              (select r.body from pulse.variant_revisions r
                where r.variant_id = v.id order by r.version desc limit 1) as previous_body
         from pulse.approvals a
         left join pulse.platform_variants v
                on v.id = a.target_id and a.target_type = 'variant'
        where a.decision = 'pending'
          and ($1::uuid is null or a.project_id = $1)
        order by a.created_at`,
      [projectId ?? null],
    );
    return rows.map(toApproval);
  });
}

/** Запрос на одобрение одной версии. */
export async function requestApproval(
  tgId: number | string,
  variantId: string,
): Promise<Approval> {
  const result = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      project_id: string;
      body: string;
      first_hook: string;
      cta: string;
      platform: Platform;
      status: string;
      title: string;
    }>(
      `select v.id, c.project_id, v.body, v.first_hook, v.cta, v.platform, v.status, c.title
         from pulse.platform_variants v
         join pulse.content_items c on c.id = v.content_item_id
        where v.id = $1`,
      [variantId],
    );
    const variant = rows[0];
    if (!variant) throw new DomainError('VARIANT_NOT_FOUND', 404);
    if (!variant.body.trim()) throw new DomainError('EMPTY_BODY');

    // Проверка качества здесь не советует, а останавливает: запрещённая
    // формулировка бренда или превышение жёсткого предела площадки не
    // должны доходить до человека, который жмёт «Одобрить».
    const findings = await qualityOf(client, variantId);
    if (hasBlockers(findings)) {
      throw new DomainError('QUALITY_BLOCKED', 409, blockersText(findings));
    }

    const hash = hashOf({
      body: variant.body,
      firstHook: variant.first_hook,
      cta: variant.cta,
    });

    // повторный запрос по тому же тексту не плодит вторую карточку
    const { rows: existing } = await client.query<ApprovalRow>(
      `select id, project_id, target_type, target_id, decision, comment, created_at, decided_at
         from pulse.approvals
        where target_type = 'variant' and target_id = $1
          and decision = 'pending' and target_hash = $2`,
      [variantId, hash],
    );
    if (existing[0]) return { approval: toApproval(existing[0]), fresh: false, variant };

    const { rows: created } = await client.query<ApprovalRow>(
      `insert into pulse.approvals
         (project_id, target_type, target_id, target_hash, requested_by)
       values ($1, 'variant', $2, $3, pulse.me())
       returning id, project_id, target_type, target_id, decision, comment, created_at, decided_at`,
      [variant.project_id, variantId, hash],
    );
    if (!created[0]) throw new DomainError('FORBIDDEN', 403);

    await client.query(
      `update pulse.platform_variants set status = 'IN_REVIEW', updated_at = now() where id = $1`,
      [variantId],
    );
    await client.query(
      `update pulse.content_items set status = 'IN_REVIEW', updated_at = now()
        where id = (select content_item_id from pulse.platform_variants where id = $1)
          and status in ('IDEA', 'DRAFT', 'CHANGES_REQUESTED')`,
      [variantId],
    );

    return { approval: toApproval(created[0]), fresh: true, variant };
  });

  if (result.fresh) {
    const recipients = await withAdmin(async (client) => {
      const ctx = await actorContext(client, tgId, result.approval.projectId);
      if (ctx) {
        await track(client, {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          name: 'approval_requested',
          props: { platform: result.variant.platform },
        });
      }
      return approverChats(client, result.approval.projectId, ctx?.userId);
    });

    // сеть — уже после коммита: Telegram может думать тридцать секунд
    await Promise.allSettled(
      recipients.map((chatId) =>
        notify(chatId, `<b>PULSE</b>\nЖдёт решения: «${escapeHtml(result.variant.title)}»`),
      ),
    );
  }

  return result.approval;
}

/**
 * Одобрение. Проверяем, что текст не изменился с момента запроса:
 * человек одобряет ровно то, что видел.
 */
export async function approve(
  tgId: number | string,
  approvalId: string,
  comment = '',
): Promise<Approval> {
  const result = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      project_id: string;
      target_id: string;
      target_hash: string;
      decision: Approval['decision'];
      body: string;
      first_hook: string;
      cta: string;
      platform: Platform;
    }>(
      `select a.id, a.project_id, a.target_id, a.target_hash, a.decision,
              v.body, v.first_hook, v.cta, v.platform
         from pulse.approvals a
         join pulse.platform_variants v on v.id = a.target_id
        where a.id = $1 and a.target_type = 'variant'
        for update of a`,
      [approvalId],
    );
    const row = rows[0];
    if (!row) throw new DomainError('APPROVAL_NOT_FOUND', 404);
    if (row.decision !== 'pending') throw new DomainError('ALREADY_DECIDED', 409);

    const current = hashOf({ body: row.body, firstHook: row.first_hook, cta: row.cta });
    if (current !== row.target_hash) {
      await client.query(
        `update pulse.approvals set decision = 'stale', decided_at = now() where id = $1`,
        [approvalId],
      );
      throw new DomainError('CONTENT_CHANGED', 409);
    }

    const { rows: decided } = await client.query<ApprovalRow>(
      `update pulse.approvals
          set decision = 'approved', decided_by = pulse.me(),
              comment = $2, decided_at = now()
        where id = $1
        returning id, project_id, target_type, target_id, decision, comment, created_at, decided_at`,
      [approvalId, comment],
    );
    assertTouched(decided.length);

    // одобренный снимок остаётся на версии: очередь сверится с ним перед отправкой
    await client.query(
      `update pulse.platform_variants
          set status = 'APPROVED', approved_hash = $2, updated_at = now()
        where id = $1`,
      [row.target_id, current],
    );
    await client.query(
      `update pulse.content_items set status = 'APPROVED', updated_at = now()
        where id = (select content_item_id from pulse.platform_variants where id = $1)`,
      [row.target_id],
    );

    return { approval: toApproval(decided[0]), platform: row.platform };
  });

  await withAdmin(async (client) => {
    const ctx = await actorContext(client, tgId, result.approval.projectId);
    if (ctx) {
      await logAction(client, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        action: 'content.approved',
        entityType: 'variant',
        entityId: result.approval.targetId,
      });
      await track(client, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: 'content_approved',
        props: { platform: result.platform },
      });
    }
  });

  return result.approval;
}

/** Возврат с комментарием. ИИ предложит правку, но не опубликует её сам. */
export async function reject(
  tgId: number | string,
  approvalId: string,
  comment: string,
): Promise<Approval> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<ApprovalRow>(
      `update pulse.approvals
          set decision = 'rejected', decided_by = pulse.me(),
              comment = $2, decided_at = now()
        where id = $1 and decision = 'pending'
        returning id, project_id, target_type, target_id, decision, comment, created_at, decided_at`,
      [approvalId, comment.trim()],
    );
    if (!rows[0]) throw new DomainError('APPROVAL_NOT_FOUND', 404);

    await client.query(
      `update pulse.platform_variants
          set status = 'CHANGES_REQUESTED', approved_hash = null, updated_at = now()
        where id = $1`,
      [rows[0].target_id],
    );
    await client.query(
      `update pulse.content_items set status = 'CHANGES_REQUESTED', updated_at = now()
        where id = (select content_item_id from pulse.platform_variants where id = $1)`,
      [rows[0].target_id],
    );

    return toApproval(rows[0]);
  });
}

/** «Одобрить всё» по пакету — по одной версии за раз, но одним нажатием. */
export async function approveAll(
  tgId: number | string,
  contentId: string,
): Promise<{ approved: number; skipped: number }> {
  const pending = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `select a.id
         from pulse.approvals a
         join pulse.platform_variants v on v.id = a.target_id
        where v.content_item_id = $1 and a.decision = 'pending'`,
      [contentId],
    );
    return rows.map((r) => r.id);
  });

  let approved = 0;
  let skipped = 0;
  for (const id of pending) {
    try {
      await approve(tgId, id);
      approved += 1;
    } catch {
      // текст успели поправить — карточка останется в списке, это честнее
      skipped += 1;
    }
  }
  return { approved, skipped };
}

/**
 * Кому уходит запрос на решение. Роль названа явно: редактор по рангу выше
 * approver'а, но одобрять он не должен — иначе автор согласует сам себя.
 */
async function approverChats(
  client: import('pg').PoolClient,
  projectId: string,
  exceptUserId?: string,
): Promise<string[]> {
  const { rows } = await client.query<{ tg_id: string }>(
    `select u.tg_id
       from pulse.memberships m
       join pulse.users u on u.id = m.user_id
       join pulse.projects p on p.workspace_id = m.workspace_id
      where p.id = $1 and m.status = 'active'
        and m.role in ('owner', 'admin', 'approver')
        and ($2::uuid is null or u.id <> $2)`,
    [projectId, exceptUserId ?? null],
  );
  return rows.map((r) => r.tg_id);
}

/** Короткий человеческий список того, что остановило отправку. */
function blockersText(findings: QualityFinding[]): string {
  return findings
    .filter((f) => f.level === 'block')
    .map((f) => f.message)
    .join('; ');
}
