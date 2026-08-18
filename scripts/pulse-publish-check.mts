/**
 * Проверка очереди публикаций на живой базе, но без выхода в сеть:
 * Telegram API подменяется заглушкой, всё остальное — настоящее.
 *
 * Два сценария, которые дороже всего стоят в проде:
 *   1. успешная отправка доходит до записи о публикации;
 *   2. повтор после сбоя не отправляет пост второй раз.
 *
 *   DATABASE_URL=... PULSE_TOKEN_KEY=... npx tsx scripts/pulse-publish-check.mts
 *
 * Скрипт создаёт свои данные и убирает их за собой.
 */
import { randomUUID } from 'node:crypto';

const realFetch = globalThis.fetch;
let apiCalls = 0;
let messageId = 1000;
globalThis.fetch = (async (url: unknown, init: unknown) => {
  if (String(url).includes('api.telegram.org')) {
    apiCalls += 1;
    messageId += 1;
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: messageId, chat: { id: -100777 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return realFetch(url as string, init as RequestInit);
}) as typeof fetch;

const { tick } = await import('../src/lib/pulse/publish');
const { withAdmin } = await import('../src/lib/pulse/db');
const { contentHash, encryptSecret, idempotencyKey } = await import('../src/lib/pulse/crypto');

let failures = 0;
const ok = (n: string, d = '') => console.log(`  ok   ${n}${d ? ` — ${d}` : ''}`);
const bad = (n: string, d: string) => {
  failures += 1;
  console.log(`  FAIL ${n} — ${d}`);
};

const tag = randomUUID().slice(0, 8);
const body = `Проверка очереди ${tag}`;
const firstHook = 'Крючок';
const cta = 'Действие';
const hash = contentHash({ body, firstHook, cta });

const ids = await withAdmin(async (c) => {
  const owner = (
    await c.query(
      `insert into pulse.users (tg_id, name) values ($1,$2)
       on conflict (tg_id) do update set name = excluded.name returning id`,
      [900000 + Math.floor(Math.random() * 89999), `Проверка ${tag}`],
    )
  ).rows[0].id as string;
  const ws = (
    await c.query(
      `insert into pulse.workspaces (name, slug, type, owner_id)
       values ($1,$2,'personal',$3) returning id`,
      [`Очередь ${tag}`, `queue-${tag}`, owner],
    )
  ).rows[0].id as string;
  await c.query(
    `insert into pulse.memberships (workspace_id, user_id, role, status)
     values ($1,$2,'owner','active') on conflict do nothing`,
    [ws, owner],
  );
  const pr = (
    await c.query(
      `insert into pulse.projects (workspace_id, name, timezone) values ($1,$2,'Europe/Moscow') returning id`,
      [ws, `Проект ${tag}`],
    )
  ).rows[0].id as string;
  const acc = (
    await c.query(
      `insert into pulse.social_accounts
         (project_id, platform, external_account_id, display_name, token_ciphertext, status)
       values ($1,'telegram','@check',$2,$3,'connected') returning id`,
      [pr, `Канал ${tag}`, encryptSecret('token-заглушка')],
    )
  ).rows[0].id as string;
  const ci = (
    await c.query(
      `insert into pulse.content_items (project_id, title, source_text, status)
       values ($1,$2,$3,'APPROVED') returning id`,
      [pr, `Материал ${tag}`, body],
    )
  ).rows[0].id as string;
  const v = (
    await c.query(
      `insert into pulse.platform_variants
         (content_item_id, platform, kind, body, first_hook, cta, status, approved_hash)
       values ($1,'telegram','post',$2,$3,$4,'APPROVED',$5) returning id`,
      [ci, body, firstHook, cta, hash],
    )
  ).rows[0].id as string;
  const s = (
    await c.query(
      `insert into pulse.schedules
         (project_id, variant_id, social_account_id, scheduled_at, timezone, status, approved_hash)
       values ($1,$2,$3, now() - interval '1 minute','Europe/Moscow','SCHEDULED',$4) returning id`,
      [pr, v, acc, hash],
    )
  ).rows[0].id as string;
  await c.query(
    `insert into pulse.publish_jobs (schedule_id, idempotency_key, status, next_retry_at)
     values ($1,$2,'PENDING', now())`,
    [s, idempotencyKey(s, hash)],
  );
  return { ws, pr, s, v, owner };
});

try {
  console.log('\nОчередь публикаций:\n');

  // Тик берёт всё, чему пора, — в базе могут лежать и чужие задачи.
  // Поэтому смотрим не на счётчик тика, а на своё расписание.
  await tick(20);
  const pub = await withAdmin(async (c) =>
    (
      await c.query(
        `select external_post_id, external_url from pulse.publications where schedule_id=$1`,
        [ids.s],
      )
    ).rows[0],
  );
  pub
    ? ok('пост ушёл и записан', `${pub.external_post_id} → ${pub.external_url}`)
    : bad('пост ушёл и записан', 'записи о публикации нет');

  const status = await withAdmin(async (c) =>
    (await c.query(`select status from pulse.platform_variants where id=$1`, [ids.v])).rows[0]
      ?.status,
  );
  status === 'PUBLISHED' ? ok('вариант помечен опубликованным') : bad('вариант помечен опубликованным', String(status));

  // Сбой между отправкой и отметкой: задача честно вернулась в очередь.
  await withAdmin(async (c) => {
    await c.query(`update pulse.schedules set status='SCHEDULED' where id=$1`, [ids.s]);
    await c.query(`update pulse.platform_variants set status='APPROVED' where id=$1`, [ids.v]);
    await c.query(
      `update pulse.publish_jobs set status='FAILED_RETRYABLE', next_retry_at=now(), locked_at=null
        where schedule_id=$1`,
      [ids.s],
    );
  });

  apiCalls = 0;
  await tick(20);
  const count = await withAdmin(async (c) =>
    Number(
      (await c.query(`select count(*)::int as n from pulse.publications where schedule_id=$1`, [ids.s]))
        .rows[0].n,
    ),
  );
  apiCalls === 0 && count === 1
    ? ok('повтор после сбоя не отправил второй пост')
    : bad('повтор после сбоя не отправил второй пост', `отправок: ${apiCalls}, публикаций: ${count}`);

  // Осиротевшее расписание: задача очереди не создалась, но публикация обязана уйти.
  const orphan = await withAdmin(async (c) => {
    const s2 = (
      await c.query(
        `insert into pulse.schedules
           (project_id, variant_id, social_account_id, scheduled_at, timezone, status, approved_hash)
         select project_id, variant_id, social_account_id, now() - interval '1 minute', timezone,
                'SCHEDULED', approved_hash
           from pulse.schedules where id=$1 returning id`,
        [ids.s],
      )
    ).rows[0].id as string;
    await c.query(`update pulse.platform_variants set status='APPROVED' where id=$1`, [ids.v]);
    return s2;
  });
  apiCalls = 0;
  await tick(20);
  const orphanPub = await withAdmin(async (c) =>
    (await c.query(`select external_post_id from pulse.publications where schedule_id=$1`, [orphan]))
      .rows[0],
  );
  orphanPub
    ? ok('расписание без задачи очередь чинит сама', String(orphanPub.external_post_id))
    : bad('расписание без задачи очередь чинит сама', 'публикации не появилось');
} finally {
  await withAdmin(async (c) => {
    await c.query(`delete from pulse.workspaces where id=$1`, [ids.ws]);
    await c.query(`delete from pulse.users where id=$1`, [ids.owner]);
  });
}

console.log(failures === 0 ? '\nОчередь ведёт себя правильно.\n' : `\n${failures} проверк(и) не прошло.\n`);
process.exit(failures === 0 ? 0 : 1);
