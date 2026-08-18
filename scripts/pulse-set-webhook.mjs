// Регистрация webhook бота PULSE.
//
// Telegram будет слать обновления на наш адрес и подписывать их секретным
// заголовком — тем же, что лежит в PULSE_TELEGRAM_WEBHOOK_SECRET. Без него
// webhook принимает кого угодно, поэтому секрет обязателен.
//
//   TELEGRAM_BOT_TOKEN=... PULSE_BASE_URL=https://... \
//   PULSE_TELEGRAM_WEBHOOK_SECRET=... node scripts/pulse-set-webhook.mjs
//
// Снять регистрацию: node scripts/pulse-set-webhook.mjs --delete

const token = process.env.TELEGRAM_BOT_TOKEN;
const base = process.env.PULSE_BASE_URL;
const secret = process.env.PULSE_TELEGRAM_WEBHOOK_SECRET;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN не задан');
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

if (process.argv.includes('--delete')) {
  const result = await api('deleteWebhook', { drop_pending_updates: false });
  console.log(result.ok ? 'Webhook снят.' : `Не вышло: ${result.description}`);
  process.exit(result.ok ? 0 : 1);
}

if (!base || !secret) {
  console.error('Нужны PULSE_BASE_URL и PULSE_TELEGRAM_WEBHOOK_SECRET');
  console.error('Секрет:  node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
  process.exit(1);
}

const url = `${base.replace(/\/$/, '')}/api/pulse/telegram/webhook`;

const me = await api('getMe');
if (!me.ok) {
  console.error(`Токен не принят: ${me.description}`);
  process.exit(1);
}

const result = await api('setWebhook', {
  url,
  secret_token: secret,
  // читаем только то, что нужно: личные сообщения и нажатия кнопок
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});

if (!result.ok) {
  console.error(`setWebhook не прошёл: ${result.description}`);
  process.exit(1);
}

const info = await api('getWebhookInfo');
console.log(`Бот @${me.result.username} слушает ${url}`);
if (info.ok && info.result.last_error_message) {
  console.log(`Последняя ошибка доставки: ${info.result.last_error_message}`);
}
