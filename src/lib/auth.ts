import { displayNameOf, verifyInitData, type TelegramUser } from './telegram/verify';

export const INIT_DATA_HEADER = 'x-telegram-init-data';

export type Caller = { tgId: number; displayName: string };

export class AuthError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

/**
 * Единственная дверь в приложение. tg_id берётся из подписанного initData,
 * никогда из тела запроса.
 */
export function callerFromRequest(req: Request): Caller {
  const initData = req.headers.get(INIT_DATA_HEADER) ?? '';

  const devTgId = devFallbackTgId();
  if (!initData && devTgId !== null) {
    return { tgId: devTgId, displayName: process.env.OBA_DEV_NAME || `dev${devTgId}` };
  }

  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const result = verifyInitData(initData, token);
  if (!result.ok) throw new AuthError(result.reason);

  const user: TelegramUser = result.user;
  return { tgId: user.id, displayName: displayNameOf(user) };
}

/**
 * Локальная разработка без Telegram. В production выключено жёстко:
 * ни один флаг окружения этого не открывает.
 */
function devFallbackTgId(): number | null {
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.OBA_ALLOW_DEV_AUTH !== '1') return null;
  const raw = process.env.OBA_DEV_TG_ID;
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}
