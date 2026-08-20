import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Токены площадок шифруются до попадания в базу. Ключ живёт в окружении,
 * а не в базе: дамп базы без ключа не даёт доступа к чужим аккаунтам.
 *
 * Формат: v1.<iv base64url>.<tag base64url>.<ciphertext base64url>
 */

const VERSION = 'v1';

function key(): Buffer {
  const raw = process.env.PULSE_TOKEN_KEY;
  if (!raw) throw new Error('PULSE_TOKEN_KEY не задан — токены площадок негде шифровать');
  // допускаем и hex, и base64: важно получить ровно 32 байта
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('PULSE_TOKEN_KEY должен быть 32 байта (64 hex или 44 base64 символа)');
  }
  return buf;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(enc)].join('.');
}

export function decryptSecret(packed: string): string {
  const [version, ivRaw, tagRaw, dataRaw] = packed.split('.');
  if (version !== VERSION || !ivRaw || !tagRaw || !dataRaw) {
    throw new Error('Не разбирается зашифрованный токен');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), unb64(ivRaw));
  decipher.setAuthTag(unb64(tagRaw));
  return Buffer.concat([decipher.update(unb64(dataRaw)), decipher.final()]).toString('utf8');
}

export function hasTokenKey(): boolean {
  return Boolean(process.env.PULSE_TOKEN_KEY);
}

/**
 * Отпечаток того, что именно одобрено. Правка текста после одобрения меняет
 * хэш — и публикация уже не совпадёт с тем, что видел человек.
 */
export function contentHash(parts: {
  body: string;
  firstHook: string;
  cta: string;
  assets?: string[];
}): string {
  const payload = JSON.stringify({
    body: parts.body,
    firstHook: parts.firstHook,
    cta: parts.cta,
    assets: [...(parts.assets ?? [])].sort(),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Ключ идемпотентности задачи публикации. Повторный запрос после сетевой
 * ошибки попадает в тот же ключ и не создаёт второй пост.
 */
export function idempotencyKey(scheduleId: string, approvedHash: string): string {
  return createHash('sha256').update(`${scheduleId}:${approvedHash}`).digest('hex').slice(0, 40);
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');
