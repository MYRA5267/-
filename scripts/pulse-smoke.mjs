/**
 * Сквозная проверка живого пути: идея → варианты → согласование → расписание
 * → очередь → публикация. Ходит по настоящему HTTP, как ходит приложение.
 *
 *   npm run dev            # в соседнем окне
 *   node scripts/pulse-smoke.mjs
 *
 * Требует dev-авторизацию (PULSE_ALLOW_DEV_AUTH=1) — в production она закрыта.
 */
const BASE = process.env.PULSE_BASE_URL || 'http://127.0.0.1:3000';
const WORKER_SECRET = process.env.PULSE_WORKER_SECRET || '';

let failures = 0;
const step = (name, detail) => console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (name, why) => {
  failures += 1;
  console.log(`  FAIL ${name} — ${why}`);
};

async function call(method, path, payload, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json };
}

async function must(name, method, path, payload, headers) {
  const { status, body } = await call(method, path, payload, headers);
  if (status >= 400) {
    fail(name, `${status} ${JSON.stringify(body).slice(0, 200)}`);
    throw new Error(`${name}: ${status}`);
  }
  return body;
}

async function main() {
  console.log('\nЖивой путь PULSE:\n');

  const session = await must('вход и заведение пользователя', 'POST', '/api/pulse/session');
  step('вход и заведение пользователя', session.me?.name ?? '—');

  const ws =
    session.workspaces?.[0] ??
    (await must('пространство', 'POST', '/api/pulse/workspaces', {
      name: 'Проверка',
      type: 'personal',
    }));
  step('пространство', ws.name);

  const project = await must('проект', 'POST', '/api/pulse/projects', {
    workspaceId: ws.id,
    name: `Смоук ${new Date().toISOString().slice(11, 19)}`,
    description: 'Проверка сквозного пути',
    timezone: 'Europe/Moscow',
  });
  step('проект', project.name);

  const account = await must(
    'подключён канал',
    'POST',
    `/api/pulse/projects/${project.id}/connections`,
    {
      platform: 'telegram',
      externalAccountId: '@pulse_smoke',
      displayName: 'Канал проверки',
      token: 'smoke-token-not-real',
    },
  );
  step('подключён канал', account.displayName ?? account.display_name ?? '—');

  const tokenLeak = JSON.stringify(account);
  if (/smoke-token-not-real/.test(tokenLeak)) fail('токен не возвращается наружу', 'токен в ответе');
  else step('токен не возвращается наружу');

  const idea = await must('идея записана', 'POST', '/api/pulse/ideas', {
    projectId: project.id,
    sourceText:
      'Разобрать, почему команды тонут в согласованиях: три причины и что делать на этой неделе.',
    objective: 'trust',
    audience: 'основатели небольших продуктовых команд',
  });
  step('идея записана', idea.title ?? idea.id);

  const packed = await must(
    'варианты собраны',
    'POST',
    `/api/pulse/ideas/${idea.id}/generate`,
    { platforms: ['telegram', 'threads'] },
  );
  const variants = packed.variants ?? packed.item?.variants ?? [];
  if (!variants.length) {
    fail('варианты собраны', 'пусто');
    throw new Error('нет вариантов');
  }
  step('варианты собраны', `${variants.length} шт., модель: ${packed.model ?? 'офлайн-черновик'}`);

  const tg = variants.find((v) => v.platform === 'telegram') ?? variants[0];

  const inspected = await must('разбор качества', 'GET', `/api/pulse/variants/${tg.id}/inspect`);
  const findings = inspected.findings ?? [];
  Array.isArray(findings)
    ? step('разбор качества', `замечаний: ${findings.length}`)
    : fail('разбор качества', 'нет поля findings');

  const approval = await must('отправлено на согласование', 'POST', '/api/pulse/approvals/request', {
    variantId: tg.id,
  });
  const approvalId = approval.approval?.id ?? approval.id;
  step('отправлено на согласование', approvalId?.slice(0, 8));

  const pending = await must('лежит в очереди решений', 'GET', '/api/pulse/approvals');
  const seen = (Array.isArray(pending) ? pending : (pending.items ?? [])).some(
    (a) => a.id === approvalId,
  );
  seen ? step('лежит в очереди решений') : fail('лежит в очереди решений', 'не нашлось');

  await must('одобрено человеком', 'POST', `/api/pulse/approvals/${approvalId}/approve`, {
    comment: 'ок',
  });
  step('одобрено человеком');

  const when = new Date(Date.now() - 60_000).toISOString();
  const schedule = await must('поставлено в календарь', 'POST', '/api/pulse/schedules', {
    variantId: tg.id,
    scheduledAt: when,
    socialAccountId: account.id,
  });
  step('поставлено в календарь', when.slice(11, 16));

  const tick = await must(
    'очередь провернулась',
    'POST',
    '/api/pulse/worker',
    {},
    { 'x-pulse-worker-secret': WORKER_SECRET },
  );
  step('очередь провернулась', JSON.stringify(tick).slice(0, 120));

  // Токен в этой проверке заведомо недействительный, поэтому отправка обязана
  // не пройти. Проверяем не «опубликовалось», а что отказ обработан по-честному:
  // задача помечена как повторяемая, а не потеряна и не зависла в PUBLISHING.
  const item = await must('состояние материала', 'GET', `/api/pulse/content/${idea.id}`);
  const after = (item.variants ?? []).find((v) => v.id === tg.id);
  after?.status === 'FAILED_RETRYABLE'
    ? step('отказ площадки обработан', 'FAILED_RETRYABLE, задача вернётся в очередь')
    : fail('отказ площадки обработан', `ожидался FAILED_RETRYABLE, получено ${after?.status}`);
  tick.retried >= 1
    ? step('назначен повтор с отступом')
    : fail('назначен повтор с отступом', JSON.stringify(tick));

  const today = await must('сводка дня открывается', 'GET', `/api/pulse/today?project=${project.id}`);
  step('сводка дня открывается', `блоков: ${Object.keys(today ?? {}).length}`);

  const analytics = await must(
    'аналитика открывается',
    'GET',
    `/api/pulse/analytics/${project.id}`,
  );
  step('аналитика открывается', `публикаций: ${analytics.publications?.length ?? 0}`);

  // Отказ в доступе — worker без секрета
  const naked = await call('POST', '/api/pulse/worker', {});
  naked.status === 401 || naked.status === 403
    ? step('очередь не крутится без секрета', String(naked.status))
    : fail('очередь не крутится без секрета', `отдал ${naked.status}`);

  // Вебхук бота: подделка не проходит, настоящий вызов проходит
  const forged = await call('POST', '/api/pulse/telegram/webhook', { update_id: 1 });
  const hookSecret = process.env.PULSE_TELEGRAM_WEBHOOK_SECRET;
  if (!hookSecret) {
    forged.status === 503
      ? step('вебхук выключен, пока не задан секрет', '503')
      : fail('вебхук выключен, пока не задан секрет', `отдал ${forged.status}`);
  } else {
    forged.status === 403
      ? step('вебхук отбивает запрос без секрета', '403')
      : fail('вебхук отбивает запрос без секрета', `отдал ${forged.status}`);

    const real = await call(
      'POST',
      '/api/pulse/telegram/webhook',
      { update_id: 2 },
      { 'x-telegram-bot-api-secret-token': hookSecret },
    );
    real.status === 200
      ? step('вебхук принимает подписанное обновление', '200')
      : fail('вебхук принимает подписанное обновление', `отдал ${real.status}`);
  }

  console.log(
    failures === 0
      ? `\nСквозной путь пройден целиком.\n`
      : `\n${failures} шаг(ов) не прошло.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nОборвалось: ${e.message}\n`);
  process.exit(1);
});
