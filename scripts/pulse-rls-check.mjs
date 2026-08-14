// Проверка, что RLS в схеме `pulse` реально работает, а не просто включён.
//
// Заводит два пространства с разными людьми и ролями, потом читает базу
// тем же путём, что и приложение — `set local role authenticated` +
// `app.tg_id` — и убеждается, что лишнего Postgres не отдаёт. За собой убирает.
//
//   DATABASE_URL=... npm run pulse:rls-check

import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined,
});

// заведомо чужие id, чтобы не задеть настоящих людей
const TG = { owner: 910000001, editor: 910000002, viewer: 910000003, alien: 910000004 };
const MARK = 'rls-check';

/** Запрос от имени человека — ровно тот путь, которым ходит приложение. */
async function asUser(tgId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['app.tg_id', String(tgId ?? '')]);
    await client.query('set local search_path = pulse, public');
    await client.query('set local role authenticated');
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Действие должно быть отвергнуто: либо ноль строк, либо ошибка прав. */
async function denied(fn) {
  try {
    const result = await fn();
    return (result?.rowCount ?? 0) === 0;
  } catch {
    return true;
  }
}

async function seed() {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local search_path = pulse, public');
    await cleanupWith(c);

    const user = async (tgId, name) => {
      const { rows } = await c.query(
        'insert into pulse.users (tg_id, name) values ($1, $2) returning id',
        [tgId, name],
      );
      return rows[0].id;
    };
    const owner = await user(TG.owner, `${MARK} owner`);
    const editor = await user(TG.editor, `${MARK} editor`);
    const viewer = await user(TG.viewer, `${MARK} viewer`);
    const alien = await user(TG.alien, `${MARK} alien`);

    const workspace = async (ownerId, slug) => {
      const { rows } = await c.query(
        'insert into pulse.workspaces (owner_id, name, slug) values ($1, $2, $3) returning id',
        [ownerId, `${MARK} ${slug}`, `${MARK}-${slug}`],
      );
      return rows[0].id;
    };
    const wsA = await workspace(owner, 'a');
    const wsB = await workspace(alien, 'b');

    const member = (ws, userId, role) =>
      c.query(
        `insert into pulse.memberships (workspace_id, user_id, role, status)
         values ($1, $2, $3, 'active')`,
        [ws, userId, role],
      );
    await member(wsA, owner, 'owner');
    await member(wsA, editor, 'editor');
    await member(wsA, viewer, 'viewer');
    await member(wsB, alien, 'owner');

    const project = async (ws, name) => {
      const { rows } = await c.query(
        'insert into pulse.projects (workspace_id, name) values ($1, $2) returning id',
        [ws, `${MARK} ${name}`],
      );
      return rows[0].id;
    };
    const projA = await project(wsA, 'a');
    const projB = await project(wsB, 'b');

    const idea = async (projectId, authorId, text) => {
      const { rows } = await c.query(
        `insert into pulse.content_items (project_id, author_id, source_text, title)
         values ($1, $2, $3, $3) returning id`,
        [projectId, authorId, text],
      );
      return rows[0].id;
    };
    const ideaA = await idea(projA, owner, `${MARK} своя идея`);
    const ideaB = await idea(projB, alien, `${MARK} чужая идея`);

    const { rows: accounts } = await c.query(
      `insert into pulse.social_accounts
         (project_id, platform, external_account_id, token_ciphertext)
       values ($1, 'telegram', $2, 'v1.secret.secret.secret') returning id`,
      [projA, `${MARK}-channel`],
    );

    await c.query('commit');
    return { wsA, wsB, projA, projB, ideaA, ideaB, accountA: accounts[0].id, editor };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

async function cleanupWith(client) {
  await client.query('delete from pulse.workspaces where slug like $1', [`${MARK}-%`]);
  await client.query('delete from pulse.users where tg_id = any($1)', [Object.values(TG)]);
}

async function cleanup() {
  const c = await pool.connect();
  try {
    await c.query('set search_path = pulse, public');
    await cleanupWith(c);
  } finally {
    c.release();
  }
}

async function main() {
  const s = await seed();

  console.log('\nRLS схемы pulse:\n');

  // ── изоляция арендаторов ──────────────────────────────
  const ownerWorkspaces = await asUser(TG.owner, (c) =>
    c.query('select id from pulse.workspaces'),
  );
  check(
    'владелец видит ровно одно пространство — своё',
    ownerWorkspaces.rowCount === 1 && ownerWorkspaces.rows[0].id === s.wsA,
    `${ownerWorkspaces.rowCount}`,
  );

  const ownerIdeas = await asUser(TG.owner, (c) =>
    c.query('select source_text from pulse.content_items order by source_text'),
  );
  const texts = ownerIdeas.rows.map((r) => r.source_text);
  check('чужая идея не выходит наружу', !texts.some((t) => t.includes('чужая')), texts.join(', '));

  const alienIdeas = await asUser(TG.alien, (c) =>
    c.query('select source_text from pulse.content_items'),
  );
  check(
    'второе пространство видит только своё',
    alienIdeas.rowCount === 1 && alienIdeas.rows[0].source_text.includes('чужая'),
    `${alienIdeas.rowCount}`,
  );

  const anon = await asUser(null, (c) => c.query('select id from pulse.content_items'));
  check('без app.tg_id база пуста', anon.rowCount === 0, `${anon.rowCount} строк`);

  // ── роли ──────────────────────────────────────────────
  const viewerWrite = await denied(() =>
    asUser(TG.viewer, (c) =>
      c.query(
        `insert into pulse.content_items (project_id, source_text) values ($1, 'подброс')`,
        [s.projA],
      ),
    ),
  );
  check('viewer не может создавать материалы', viewerWrite);

  const editorWrite = await asUser(TG.editor, (c) =>
    c.query(
      `insert into pulse.content_items (project_id, source_text, title)
       values ($1, $2, $2)`,
      [s.projA, `${MARK} от редактора`],
    ),
  );
  check('editor может создавать материалы', editorWrite.rowCount === 1);

  const editorProject = await denied(() =>
    asUser(TG.editor, (c) =>
      c.query(
        `insert into pulse.projects (workspace_id, name) values ($1, 'подброс')`,
        [s.wsA],
      ),
    ),
  );
  check('editor не может заводить проекты', editorProject);

  const editorConnect = await denied(() =>
    asUser(TG.editor, (c) =>
      c.query(
        `insert into pulse.social_accounts (project_id, platform, external_account_id)
         values ($1, 'telegram', 'подброс')`,
        [s.projA],
      ),
    ),
  );
  check('editor не может трогать интеграции', editorConnect);

  const alienWrite = await denied(() =>
    asUser(TG.alien, (c) =>
      c.query(
        `insert into pulse.content_items (project_id, source_text) values ($1, 'подброс')`,
        [s.projA],
      ),
    ),
  );
  check('чужак не может писать в чужой проект', alienWrite);

  const alienUpdate = await asUser(TG.alien, (c) =>
    c.query('update pulse.content_items set title = $2 where id = $1', [s.ideaA, 'взлом']),
  );
  check('чужак не может править чужой материал', alienUpdate.rowCount === 0);

  // ── секреты ───────────────────────────────────────────
  const tokenLeak = await denied(() =>
    asUser(TG.owner, (c) => c.query('select token_ciphertext from pulse.social_accounts')),
  );
  check('токен площадки не читается даже владельцем', tokenLeak);

  const accountVisible = await asUser(TG.owner, (c) =>
    c.query('select id, platform, status from pulse.social_accounts'),
  );
  check(
    'сам факт подключения при этом виден',
    accountVisible.rowCount === 1,
    `${accountVisible.rowCount}`,
  );

  // ── очередь и журнал принадлежат серверу ──────────────
  const jobWrite = await denied(() =>
    asUser(TG.owner, (c) =>
      c.query(
        `insert into pulse.publish_jobs (schedule_id, idempotency_key)
         values (gen_random_uuid(), 'подброс')`,
      ),
    ),
  );
  check('приложение не может писать в очередь публикаций', jobWrite);

  const auditWrite = await denied(() =>
    asUser(TG.owner, (c) =>
      c.query(
        `insert into pulse.audit_logs (workspace_id, action, entity_type)
         values ($1, 'подделка', 'workspace')`,
        [s.wsA],
      ),
    ),
  );
  check('журнал действий нельзя подделать изнутри приложения', auditWrite);

  const workspaceInsert = await denied(() =>
    asUser(TG.owner, (c) =>
      c.query(
        `insert into pulse.workspaces (owner_id, name, slug)
         values (pulse.me(), 'подброс', 'подброс')`,
      ),
    ),
  );
  check('пространство создаётся только привилегированным путём', workspaceInsert);

  await cleanup();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} проверок прошло.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  process.exit(1);
});
