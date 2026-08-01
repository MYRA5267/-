import { createHmac, timingSafeEqual } from 'node:crypto';

export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
};

export type VerifyResult =
  | { ok: true; user: TelegramUser; authDate: Date }
  | { ok: false; reason: string };

const DEFAULT_MAX_AGE_SEC = 24 * 60 * 60;

/**
 * Проверка подписи Telegram initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Клиенту не верим ни в чём: tg_id берётся только отсюда.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number = DEFAULT_MAX_AGE_SEC,
): VerifyResult {
  if (!initData) return { ok: false, reason: 'EMPTY_INIT_DATA' };
  if (!botToken) return { ok: false, reason: 'NO_BOT_TOKEN' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'NO_HASH' };
  params.delete('hash');
  params.delete('signature'); // подпись Ed25519 для третьих сторон, в HMAC не участвует

  // сортировка строго по ключу, как в спеке Telegram
  const pairs: Array<[string, string]> = [];
  params.forEach((value, key) => {
    pairs.push([key, value]);
  });
  const dataCheckString = pairs
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  const authDateRaw = params.get('auth_date');
  if (!authDateRaw) return { ok: false, reason: 'NO_AUTH_DATE' };
  const authDate = new Date(Number(authDateRaw) * 1000);
  if (Number.isNaN(authDate.getTime())) return { ok: false, reason: 'BAD_AUTH_DATE' };
  if (Date.now() - authDate.getTime() > maxAgeSec * 1000) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'NO_USER' };

  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    return { ok: false, reason: 'BAD_USER_JSON' };
  }
  if (typeof user.id !== 'number') return { ok: false, reason: 'BAD_USER_ID' };

  return { ok: true, user, authDate };
}

export function displayNameOf(user: TelegramUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.username || `id${user.id}`;
}
