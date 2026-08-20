import type { PoolClient } from 'pg';

/**
 * Журнал действий и продуктовые события.
 *
 * Обе таблицы пишутся только привилегированным путём: у роли authenticated
 * нет insert. Историю нельзя подделать изнутри приложения.
 */

export type AuditEntry = {
  workspaceId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
};

export async function logAction(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `insert into pulse.audit_logs
       (workspace_id, actor_id, action, entity_type, entity_id, before_json, after_json)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.workspaceId,
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}

/** Продуктовые события из раздела 16 ТЗ. */
export type ProductEvent =
  | 'onboarding_started'
  | 'workspace_created'
  | 'project_created'
  | 'social_connected'
  | 'idea_created'
  | 'content_generated'
  | 'variant_edited'
  | 'approval_requested'
  | 'content_approved'
  | 'publication_scheduled'
  | 'publication_succeeded'
  | 'publication_failed'
  | 'metrics_imported'
  | 'insight_opened'
  | 'hypothesis_accepted';

export async function track(
  client: PoolClient,
  event: {
    workspaceId: string | null;
    userId: string | null;
    name: ProductEvent;
    props?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    'insert into pulse.events (workspace_id, user_id, name, props_json) values ($1, $2, $3, $4)',
    [event.workspaceId, event.userId, event.name, JSON.stringify(event.props ?? {})],
  );
}
