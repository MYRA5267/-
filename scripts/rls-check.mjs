// Проверка, что RLS реально работает, а не просто включён.
//
// Заводит две пары и секретные пункты, потом читает базу так же, как это
// делает приложение — `set local role authenticated` + `app.tg_id` —
// и убеждается, что лишнего Postgres не отдаёт. За собой убирает.
//
//   DATABASE_URL=... npm run db:rls-check

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

const TG = { a: 900000001, b: 900000002, c: 900000003 };

/** Запрос от имени человека — ровно тот путь, которым ходит приложение. */
async function asUser(tgId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['app.tg_id', String(tgId ?? '')]);
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

async function seed() {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('delete from public.users where tg_id = any($1)', [Object.values(TG)]);

    const mk = async (code) => {
      const { rows } = await c.query(
        'insert into public.couples (invite_code) values ($1) returning id',
        [code],
      );
      return rows[0].id;
    };
    const couple1 = await mk('TST111');
    const couple2 = await mk('TST222');

    const user = async (coupleId, tgId, name, ink) => {
      const { rows } = await c.query(
        `insert into public.users (tg_id, couple_id, display_name, ink)
         values ($1, $2, $3, $4) returning id`,
        [tgId, coupleId, name, ink],
      );
      return rows[0].id;
    };
    const a = await user(couple1, TG.a, 'A', 'blue');
    const b = await user(couple1, TG.b, 'B', 'pink');
    const cc = await user(couple2, TG.c, 'C', 'blue');

    const item = async (coupleId, authorId, text, secretOwner = null) => {
      const { rows } = await c.query(
        `insert into public.items (couple_id, author_id, type, text, secret_owner)
         values ($1, $2, 'task', $3, $4) returning id`,
        [coupleId, authorId, text, secretOwner],
      );
      return rows[0].id;
    };
    const shared = await item(couple1, a, 'общий пункт');
    const secretA = await item(couple1, a, 'секрет A', a);
    const secretB = await item(couple1, b, 'секрет B', b);
    const foreign = await item(couple2, cc, 'чужая пара');

    await c.query('commit');
    return { couple1, couple2, a, b, cc, shared, secretA, secretB, foreign };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

async function cleanup() {
  await pool.query('delete from public.couples where invite_code in ($1, $2)', ['TST111', 'TST222']);
}

async function main() {
  const s = await seed();
  const texts = async (tgId) => {
    const rows = await asUser(tgId, (c) => c.query('select text from public.items order by text'));
    return rows.rows.map((r) => r.text);
  };

  console.log('\nRLS:\n');

  const a = await texts(TG.a);
  check('A видит общий пункт и свой секрет', a.join('|') === 'общий пункт|секрет A', a.join(', '));
  check('секрет B не выходит к A', !a.includes('секрет B'));
  check('чужая пара не выходит к A', !a.includes('чужая пара'));

  const b = await texts(TG.b);
  check('B видит общий пункт и свой секрет', b.join('|') === 'общий пункт|секрет B', b.join(', '));
  check('секрет A не выходит к B', !b.includes('секрет A'));

  const c = await texts(TG.c);
  check('вторая пара видит только своё', c.join('|') === 'чужая пара', c.join(', '));

  const anon = await texts(null);
  check('без app.tg_id база пуста', anon.length === 0, `${anon.length} строк`);

  const upd = await asUser(TG.a, (cl) =>
    cl.query('update public.items set done = true where id = $1', [s.secretB]),
  );
  check('A не может править секрет B', upd.rowCount === 0, `${upd.rowCount} строк`);

  const del = await asUser(TG.a, (cl) =>
    cl.query('delete from public.items where id = $1', [s.foreign]),
  );
  check('A не может удалить чужой пункт', del.rowCount === 0, `${del.rowCount} строк`);

  let blocked = false;
  try {
    await asUser(TG.a, (cl) =>
      cl.query(
        `insert into public.items (couple_id, author_id, type, text)
         values ($1, $2, 'task', 'подброс')`,
        [s.couple2, s.a],
      ),
    );
  } catch {
    blocked = true;
  }
  check('A не может писать в чужую пару', blocked);

  const couples = await asUser(TG.a, (cl) => cl.query('select id from public.couples'));
  check('A видит ровно одну пару — свою', couples.rowCount === 1, `${couples.rowCount}`);

  const people = await asUser(TG.a, (cl) => cl.query('select id from public.users'));
  check('A видит ровно двоих — себя и партнёра', people.rowCount === 2, `${people.rowCount}`);

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
