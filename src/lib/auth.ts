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

  if (!initData && devAuthOpen()) {
    // Заголовок нужен, чтобы локально можно было ходить двумя людьми сразу
    // и проверять приватность так, как требует спека — вторым аккаунтом.
    const fromHeader = Number(req.headers.get('x-oba-dev-tg-id'));
    const tgId = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : devFallbackTgId();
    if (tgId !== null) {
      // заголовки — latin-1, поэтому имя принимаем ещё и percent-encoded
      const header = req.headers.get('x-oba-dev-name');
      let name = header || process.env.OBA_DEV_NAME || `dev${tgId}`;
      try {
        name = decodeURIComponent(name);
      } catch {
        /* не encoded — берём как есть */
      }
      return { tgId, displayName: name };
    }
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
function devAuthOpen(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.OBA_ALLOW_DEV_AUTH === '1';
}

function devFallbackTgId(): number | null {
  if (!devAuthOpen()) return null;
  const raw = process.env.OBA_DEV_TG_ID;
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}
