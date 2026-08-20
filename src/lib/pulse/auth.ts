import { displayNameOf, verifyInitData } from '../telegram/verify';

export const INIT_DATA_HEADER = 'x-telegram-init-data';

export type Caller = { tgId: number; displayName: string };

export class AuthError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

/**
 * Единственная дверь в PULSE. tg_id берётся из подписанного initData,
 * никогда из тела запроса и никогда из заголовка, который может подделать клиент.
 */
export function callerFromRequest(req: Request): Caller {
  const initData = req.headers.get(INIT_DATA_HEADER) ?? '';

  const devTgId = devFallbackTgId();
  if (!initData && devTgId !== null) {
    return { tgId: devTgId, displayName: process.env.PULSE_DEV_NAME || `dev${devTgId}` };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const result = verifyInitData(initData, token);
  if (!result.ok) throw new AuthError(result.reason);

  return { tgId: result.user.id, displayName: displayNameOf(result.user) };
}

/**
 * Локальная разработка без Telegram. В production выключено жёстко:
 * ни один флаг окружения этого не открывает.
 */
function devFallbackTgId(): number | null {
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.PULSE_ALLOW_DEV_AUTH !== '1') return null;
  const raw = process.env.PULSE_DEV_TG_ID;
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/**
 * Служебный вызов: тик очереди по расписанию.
 *
 * Два источника — собственный worker со своим заголовком и планировщик
 * платформы, который присылает `Authorization: Bearer`. Оба сверяются
 * с секретом из окружения; без секрета не проходит никто.
 */
export function isServiceCall(req: Request): boolean {
  const own = process.env.PULSE_WORKER_SECRET;
  if (own && equals(req.headers.get('x-pulse-worker-secret') ?? '', own)) return true;

  const cron = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  if (cron && auth.startsWith('Bearer ') && equals(auth.slice(7), cron)) return true;

  return false;
}

/** Сравнение без ранней остановки на первом различии. */
function equals(got: string, expected: string): boolean {
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  }
  return diff === 0;
}
