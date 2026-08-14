import { DomainError, assertTouched, withAdmin, withUser } from './db';
import { encryptSecret, hasTokenKey } from './crypto';
import { logAction, track } from './audit';
import { connectorFor } from './connectors';
import type { BrandProfile, Platform, Project, SocialAccount } from './types';

type ProjectRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  timezone: string;
  accent: string;
  status: Project['status'];
};

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  description: r.description,
  timezone: r.timezone,
  accent: r.accent,
  status: r.status,
});

export async function listProjects(
  tgId: number | string,
  workspaceId?: string,
): Promise<Project[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `select id, workspace_id, name, description, timezone, accent, status
         from pulse.projects
        where status <> 'archived'
          and ($1::uuid is null or workspace_id = $1)
        order by created_at`,
      [workspaceId ?? null],
    );
    return rows.map(toProject);
  });
}

export async function getProject(tgId: number | string, projectId: string): Promise<Project> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `select id, workspace_id, name, description, timezone, accent, status
         from pulse.projects where id = $1`,
      [projectId],
    );
    if (!rows[0]) throw new DomainError('PROJECT_NOT_FOUND', 404);
    return toProject(rows[0]);
  });
}

export async function createProject(
  tgId: number | string,
  input: { workspaceId: string; name: string; description?: string; timezone?: string },
): Promise<Project> {
  const name = input.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');

  return withUser(tgId, async (client) => {
    const { rows } = await client.query<ProjectRow>(
      `insert into pulse.projects (workspace_id, name, description, timezone)
       values ($1, $2, $3, coalesce($4, 'Europe/Amsterdam'))
       returning id, workspace_id, name, description, timezone, accent, status`,
      [input.workspaceId, name, input.description?.trim() || null, input.timezone ?? null],
    );
    if (!rows[0]) throw new DomainError('FORBIDDEN', 403);

    // пустой бренд-профиль сразу: экран проекта не должен показывать «ничего нет»
    await client.query(
      'insert into pulse.brand_profiles (project_id) values ($1) on conflict do nothing',
      [rows[0].id],
    );
    return toProject(rows[0]);
  }).then(async (project) => {
    await withAdmin(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'select id from pulse.users where tg_id = $1',
        [String(tgId)],
      );
      await logAction(client, {
        workspaceId: input.workspaceId,
        actorId: rows[0]?.id ?? null,
        action: 'project.created',
        entityType: 'project',
        entityId: project.id,
        after: { name: project.name },
      });
      await track(client, {
        workspaceId: input.workspaceId,
        userId: rows[0]?.id ?? null,
        name: 'project_created',
      });
    });
    return project;
  });
}

// ─────────────────────────────────────────────────────────────
// Brand Brain
// ─────────────────────────────────────────────────────────────

type BrandRow = {
  project_id: string;
  positioning: string;
  audiences_json: string[];
  voice_json: BrandProfile['voice'];
  prohibited_phrases_json: string[];
  examples_json: BrandProfile['examples'];
  facts_json: BrandProfile['facts'];
  default_cta: string;
};

export async function getBrand(
  tgId: number | string,
  projectId: string,
): Promise<BrandProfile | null> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<BrandRow>(
      `select project_id, positioning, audiences_json, voice_json,
              prohibited_phrases_json, examples_json, facts_json, default_cta
         from pulse.brand_profiles where project_id = $1`,
      [projectId],
    );
    return rows[0] ? toBrand(rows[0]) : null;
  });
}

export function toBrand(r: BrandRow): BrandProfile {
  return {
    projectId: r.project_id,
    positioning: r.positioning,
    audiences: r.audiences_json ?? [],
    voice: r.voice_json ?? {},
    prohibitedPhrases: r.prohibited_phrases_json ?? [],
    examples: r.examples_json ?? { good: [], bad: [] },
    facts: r.facts_json ?? [],
    defaultCta: r.default_cta,
  };
}

export async function saveBrand(
  tgId: number | string,
  projectId: string,
  patch: Partial<Omit<BrandProfile, 'projectId'>>,
): Promise<BrandProfile> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<BrandRow>(
      `insert into pulse.brand_profiles as b
         (project_id, positioning, audiences_json, voice_json,
          prohibited_phrases_json, examples_json, facts_json, default_cta, updated_at)
       values ($1,
               coalesce($2, ''), coalesce($3, '[]'::jsonb), coalesce($4, '{}'::jsonb),
               coalesce($5, '[]'::jsonb), coalesce($6, '{"good":[],"bad":[]}'::jsonb),
               coalesce($7, '[]'::jsonb), coalesce($8, ''), now())
       on conflict (project_id) do update set
         positioning = coalesce($2, b.positioning),
         audiences_json = coalesce($3, b.audiences_json),
         voice_json = coalesce($4, b.voice_json),
         prohibited_phrases_json = coalesce($5, b.prohibited_phrases_json),
         examples_json = coalesce($6, b.examples_json),
         facts_json = coalesce($7, b.facts_json),
         default_cta = coalesce($8, b.default_cta),
         updated_at = now()
       returning project_id, positioning, audiences_json, voice_json,
                 prohibited_phrases_json, examples_json, facts_json, default_cta`,
      [
        projectId,
        patch.positioning ?? null,
        patch.audiences ? JSON.stringify(patch.audiences) : null,
        patch.voice ? JSON.stringify(patch.voice) : null,
        patch.prohibitedPhrases ? JSON.stringify(patch.prohibitedPhrases) : null,
        patch.examples ? JSON.stringify(patch.examples) : null,
        patch.facts ? JSON.stringify(patch.facts) : null,
        patch.defaultCta ?? null,
      ],
    );
    if (!rows[0]) throw new DomainError('FORBIDDEN', 403);
    return toBrand(rows[0]);
  });
}

// ─────────────────────────────────────────────────────────────
// Подключения
// ─────────────────────────────────────────────────────────────

type AccountRow = {
  id: string;
  project_id: string;
  platform: Platform;
  external_account_id: string;
  display_name: string;
  status: SocialAccount['status'];
  token_expires_at: string | null;
  last_synced_at: string | null;
};

const toAccount = (r: AccountRow): SocialAccount => ({
  id: r.id,
  projectId: r.project_id,
  platform: r.platform,
  externalAccountId: r.external_account_id,
  displayName: r.display_name,
  status: r.status,
  tokenExpiresAt: r.token_expires_at,
  lastSyncedAt: r.last_synced_at,
});

/** Токены сюда не попадают: их нет в grant на колонки. */
export async function listAccounts(
  tgId: number | string,
  projectId: string,
): Promise<SocialAccount[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<AccountRow>(
      `select id, project_id, platform, external_account_id, display_name,
              status, token_expires_at, last_synced_at
         from pulse.social_accounts where project_id = $1 order by platform`,
      [projectId],
    );
    return rows.map(toAccount);
  });
}

/**
 * Подключение канала. Пароли соцсетей не запрашиваются: для Telegram
 * достаточно, чтобы бот был админом канала. Если токен всё-таки передан,
 * он шифруется до записи и обратно во frontend не возвращается.
 */
export async function connectAccount(
  tgId: number | string,
  input: {
    projectId: string;
    platform: Platform;
    externalAccountId: string;
    displayName?: string;
    token?: string;
  },
): Promise<SocialAccount> {
  const external = input.externalAccountId.trim();
  if (!external) throw new DomainError('ACCOUNT_ID_REQUIRED');
  if (input.token && !hasTokenKey()) throw new DomainError('NO_TOKEN_KEY', 503);

  const status: SocialAccount['status'] = connectorFor(input.platform).autoPublish
    ? 'connected'
    : 'export_only';

  const account = await withUser(tgId, async (client) => {
    const { rows } = await client.query<AccountRow>(
      `insert into pulse.social_accounts
         (project_id, platform, external_account_id, display_name, status)
       values ($1, $2, $3, $4, $5)
       on conflict (project_id, platform, external_account_id)
       do update set display_name = excluded.display_name, status = excluded.status
       returning id, project_id, platform, external_account_id, display_name,
                 status, token_expires_at, last_synced_at`,
      [input.projectId, input.platform, external, input.displayName?.trim() || external, status],
    );
    if (!rows[0]) throw new DomainError('FORBIDDEN', 403);
    return toAccount(rows[0]);
  });

  if (input.token) {
    // запись секрета — только привилегированным путём: колонка недоступна
    // роли authenticated, и это правильно
    await withAdmin(async (client) => {
      await client.query(
        'update pulse.social_accounts set token_ciphertext = $2 where id = $1',
        [account.id, encryptSecret(input.token as string)],
      );
    });
  }

  await withAdmin(async (client) => {
    const { rows } = await client.query<{ id: string; workspace_id: string }>(
      `select u.id, p.workspace_id
         from pulse.users u, pulse.projects p
        where u.tg_id = $1 and p.id = $2`,
      [String(tgId), input.projectId],
    );
    if (rows[0]) {
      await logAction(client, {
        workspaceId: rows[0].workspace_id,
        actorId: rows[0].id,
        action: 'social.connected',
        entityType: 'social_account',
        entityId: account.id,
        after: { platform: input.platform, externalAccountId: external },
      });
      await track(client, {
        workspaceId: rows[0].workspace_id,
        userId: rows[0].id,
        name: 'social_connected',
        props: { platform: input.platform },
      });
    }
  });

  return account;
}

/** Тестовая проверка доступа без публикации. */
export async function testAccount(
  tgId: number | string,
  accountId: string,
): Promise<{ ok: boolean; message: string }> {
  const account = await withUser(tgId, async (client) => {
    const { rows } = await client.query<AccountRow>(
      `select id, project_id, platform, external_account_id, display_name,
              status, token_expires_at, last_synced_at
         from pulse.social_accounts where id = $1`,
      [accountId],
    );
    if (!rows[0]) throw new DomainError('ACCOUNT_NOT_FOUND', 404);
    return toAccount(rows[0]);
  });

  const token = await readToken(accountId);
  const result = await connectorFor(account.platform).test({
    externalAccountId: account.externalAccountId,
    token,
  });

  const ok = result.ok;
  const message = ok
    ? 'info' in result
      ? result.info
      : 'Доступ есть'
    : result.message;

  await withAdmin(async (client) => {
    await client.query(
      `update pulse.social_accounts
          set status = $2, last_synced_at = now()
        where id = $1`,
      [accountId, ok ? 'connected' : 'auth_required'],
    );
  });

  return { ok, message };
}

/**
 * Расшифрованный токен. Только привилегированным путём и только внутри
 * сервера: наружу секреты не возвращаются никогда.
 */
export async function readToken(accountId: string): Promise<string | null> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{ token_ciphertext: string | null }>(
      'select token_ciphertext from pulse.social_accounts where id = $1',
      [accountId],
    );
    const packed = rows[0]?.token_ciphertext;
    if (!packed) return null;
    const { decryptSecret } = await import('./crypto');
    return decryptSecret(packed);
  });
}

export async function disconnectAccount(
  tgId: number | string,
  accountId: string,
): Promise<void> {
  await withUser(tgId, async (client) => {
    const { rowCount } = await client.query('delete from pulse.social_accounts where id = $1', [
      accountId,
    ]);
    assertTouched(rowCount);
  });
}
