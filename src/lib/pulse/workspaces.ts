import type { PoolClient } from 'pg';
import { DomainError, withAdmin, withUser } from './db';
import { logAction, track } from './audit';
import type { Me, Role, Workspace } from './types';

type UserRow = { id: string; tg_id: string; name: string; timezone: string };

/**
 * Первый вход: заводим человека. Идемпотентно.
 * Привилегированный путь — своей строки у него ещё нет, RLS про него
 * ничего не знает.
 */
export async function ensureUser(tgId: number | string, displayName: string): Promise<Me> {
  return withAdmin(async (client) => {
    const existing = await findUser(client, tgId);
    if (existing) {
      if (displayName && displayName !== existing.name) {
        await client.query('update pulse.users set name = $2 where id = $1', [
          existing.id,
          displayName,
        ]);
        existing.name = displayName;
      }
      return toMe(existing);
    }

    const { rows } = await client.query<UserRow>(
      `insert into pulse.users (tg_id, name) values ($1, $2)
       returning id, tg_id, name, timezone`,
      [String(tgId), displayName],
    );
    return toMe(rows[0]);
  });
}

async function findUser(client: PoolClient, tgId: number | string) {
  const { rows } = await client.query<UserRow>(
    'select id, tg_id, name, timezone from pulse.users where tg_id = $1',
    [String(tgId)],
  );
  return rows[0] ?? null;
}

const toMe = (r: UserRow): Me => ({
  id: r.id,
  tgId: String(r.tg_id),
  name: r.name,
  timezone: r.timezone,
});

/** Пространства человека — уже под RLS: чужого он не увидит. */
export async function listWorkspaces(tgId: number | string): Promise<Workspace[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      slug: string;
      type: Workspace['type'];
      plan: string;
      role: Role;
      project_count: string;
    }>(
      `select w.id, w.name, w.slug, w.type, w.plan, m.role,
              (select count(*) from pulse.projects p
                where p.workspace_id = w.id and p.status <> 'archived') as project_count
         from pulse.workspaces w
         join pulse.memberships m on m.workspace_id = w.id
        where m.user_id = pulse.me() and m.status = 'active'
        order by w.created_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      type: r.type,
      plan: r.plan,
      role: r.role,
      projectCount: Number(r.project_count),
    }));
  });
}

/**
 * Создание пространства. Привилегированный путь: у создателя ещё нет
 * членства, значит его ранг равен нулю и никакая политика его не пропустит.
 * Ровно два действия одной транзакцией: пространство и владелец в нём.
 */
export async function createWorkspace(
  tgId: number | string,
  input: { name: string; type: Workspace['type'] },
): Promise<Workspace> {
  const name = input.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');

  return withAdmin(async (client) => {
    const me = await findUser(client, tgId);
    if (!me) throw new DomainError('NO_USER', 401);

    const slug = await uniqueSlug(client, name);
    const { rows } = await client.query<{ id: string; slug: string; plan: string }>(
      `insert into pulse.workspaces (owner_id, name, slug, type)
       values ($1, $2, $3, $4) returning id, slug, plan`,
      [me.id, name, slug, input.type],
    );
    const workspace = rows[0];

    await client.query(
      `insert into pulse.memberships (workspace_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')`,
      [workspace.id, me.id],
    );

    await logAction(client, {
      workspaceId: workspace.id,
      actorId: me.id,
      action: 'workspace.created',
      entityType: 'workspace',
      entityId: workspace.id,
      after: { name, type: input.type },
    });
    await track(client, {
      workspaceId: workspace.id,
      userId: me.id,
      name: 'workspace_created',
      props: { type: input.type },
    });

    return {
      id: workspace.id,
      name,
      slug: workspace.slug,
      type: input.type,
      plan: workspace.plan,
      role: 'owner',
      projectCount: 0,
    };
  });
}

async function uniqueSlug(client: PoolClient, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'space';
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? base : `${base}-${i}`;
    const { rowCount } = await client.query('select 1 from pulse.workspaces where slug = $1', [
      candidate,
    ]);
    if (!rowCount) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export type Member = {
  userId: string;
  name: string;
  role: Role;
  status: string;
};

export async function listMembers(
  tgId: number | string,
  workspaceId: string,
): Promise<Member[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<{
      user_id: string;
      name: string;
      role: Role;
      status: string;
    }>(
      `select m.user_id, u.name, m.role, m.status
         from pulse.memberships m
         join pulse.users u on u.id = m.user_id
        where m.workspace_id = $1
        order by (select rank from pulse.roles where role = m.role) desc, u.name`,
      [workspaceId],
    );
    return rows.map((r) => ({ userId: r.user_id, name: r.name, role: r.role, status: r.status }));
  });
}

/** Приглашение: код на 14 дней с заранее заданной ролью. */
export async function createInvitation(
  tgId: number | string,
  workspaceId: string,
  role: Role,
): Promise<{ code: string; role: Role; expiresAt: string }> {
  if (role === 'owner') throw new DomainError('OWNER_NOT_INVITABLE');

  return withUser(tgId, async (client) => {
    const { rows } = await client.query<{ code: string; expires_at: string }>(
      `insert into pulse.invitations (workspace_id, role, created_by)
       values ($1, $2, pulse.me()) returning code, expires_at`,
      [workspaceId, role],
    );
    if (!rows[0]) throw new DomainError('FORBIDDEN', 403);
    return { code: rows[0].code, role, expiresAt: rows[0].expires_at };
  });
}

/**
 * Вход по коду. Привилегированный путь: человек ещё не участник, RLS его
 * в это пространство не пустит. Код одноразовый.
 */
export async function joinByCode(tgId: number | string, rawCode: string): Promise<Workspace> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) throw new DomainError('INVALID_CODE');

  return withAdmin(async (client) => {
    const me = await findUser(client, tgId);
    if (!me) throw new DomainError('NO_USER', 401);

    const { rows } = await client.query<{
      id: string;
      workspace_id: string;
      role: Role;
      expires_at: string;
      accepted_by: string | null;
    }>(
      `select id, workspace_id, role, expires_at, accepted_by
         from pulse.invitations where code = $1 for update`,
      [code],
    );
    const invite = rows[0];
    if (!invite) throw new DomainError('INVALID_CODE', 404);
    if (invite.accepted_by) throw new DomainError('CODE_USED', 409);
    if (new Date(invite.expires_at) < new Date()) throw new DomainError('CODE_EXPIRED', 409);

    const { rowCount: already } = await client.query(
      `select 1 from pulse.memberships
        where workspace_id = $1 and user_id = $2 and status = 'active'`,
      [invite.workspace_id, me.id],
    );
    if (already) throw new DomainError('ALREADY_MEMBER', 409);

    await client.query(
      `insert into pulse.memberships (workspace_id, user_id, role, invited_by, status)
       values ($1, $2, $3, (select created_by from pulse.invitations where id = $4), 'active')
       on conflict (workspace_id, user_id)
       do update set role = excluded.role, status = 'active'`,
      [invite.workspace_id, me.id, invite.role, invite.id],
    );
    await client.query(
      'update pulse.invitations set accepted_by = $1, accepted_at = now() where id = $2',
      [me.id, invite.id],
    );

    await logAction(client, {
      workspaceId: invite.workspace_id,
      actorId: me.id,
      action: 'member.joined',
      entityType: 'membership',
      entityId: me.id,
      after: { role: invite.role },
    });

    const { rows: ws } = await client.query<{
      id: string;
      name: string;
      slug: string;
      type: Workspace['type'];
      plan: string;
      project_count: string;
    }>(
      `select w.id, w.name, w.slug, w.type, w.plan,
              (select count(*) from pulse.projects p where p.workspace_id = w.id) as project_count
         from pulse.workspaces w where w.id = $1`,
      [invite.workspace_id],
    );
    const w = ws[0];
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      type: w.type,
      plan: w.plan,
      role: invite.role,
      projectCount: Number(w.project_count),
    };
  });
}
