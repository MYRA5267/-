import { NextResponse } from 'next/server';
import { AuthError, callerFromRequest, type Caller } from './auth';
import { DomainError, isDbConfigured } from './db';
import { AiError } from './ai/provider';

/**
 * Один вход для всех роутов PULSE.
 *
 * Сначала подпись, потом всё остальное: неподтверждённый вызывающий не
 * должен узнавать даже состояние конфигурации. Секреты и стектрейсы
 * наружу не уходят — только код ошибки.
 */
export async function handle<T>(
  req: Request,
  fn: (caller: Caller) => Promise<T>,
): Promise<NextResponse> {
  let caller: Caller;
  try {
    caller = callerFromRequest(req);
  } catch (e) {
    const reason = e instanceof AuthError ? e.reason : 'AUTH_FAILED';
    return NextResponse.json({ error: 'UNAUTHORIZED', detail: reason }, { status: 401 });
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: 'DB_NOT_CONFIGURED' }, { status: 503 });
  }

  try {
    const result = await fn(caller);
    return NextResponse.json(result ?? { ok: true });
  } catch (e) {
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.code }, { status: e.status });
    }
    if (e instanceof AiError) {
      return NextResponse.json({ error: e.code, detail: e.message }, { status: 502 });
    }
    console.error('[pulse]', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}

/** Тело запроса как объект. Пустое тело — пустой объект, а не падение. */
export async function body<T extends Record<string, unknown>>(req: Request): Promise<Partial<T>> {
  try {
    const parsed = await req.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<T>) : {};
  } catch {
    return {};
  }
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Значение из списка допустимых — иначе undefined, а не «что прислали». */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Идентификатор из запроса.
 *
 * Без этой проверки пустая строка или мусор уходят в сравнение с uuid,
 * Postgres отвечает 22P02, а человек видит «сервер не ответил» вместо
 * внятного «неверный адрес».
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, code = 'BAD_ID'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new DomainError(code, 400);
  return value;
}

/** То же, но необязательное: пусто — значит «без фильтра». */
export function optionalUuid(value: unknown, code = 'BAD_ID'): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return uuid(value, code);
}

/** Значение обязано быть из списка — иначе понятная ошибка, а не 500. */
export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
): T {
  const found = oneOf(value, allowed);
  if (!found) throw new DomainError(code, 400);
  return found;
}
