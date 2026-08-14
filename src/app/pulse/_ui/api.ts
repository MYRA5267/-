'use client';

/**
 * Единственный способ, которым экран разговаривает с сервером.
 * initData добывается один раз и прикладывается ко всем запросам —
 * сервер проверяет подпись и берёт tg_id только оттуда.
 */

let initData: string | undefined;
let resolved = false;

export async function ensureInitData(): Promise<string | undefined> {
  if (resolved) return initData;
  resolved = true;
  try {
    const sdk = await import('@telegram-apps/sdk-react');
    if (!sdk.isTMA()) return undefined;
    sdk.init();
    initData = sdk.retrieveRawInitData();
  } catch {
    // браузер вне Telegram: работаем через dev-вход, если он включён
  }
  return initData;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public detail?: string,
  ) {
    super(code);
  }
}

async function call<T>(method: string, url: string, payload?: unknown): Promise<T> {
  await ensureInitData();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (initData) headers['x-telegram-init-data'] = initData;

  const response = await fetch(url, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  const text = await response.text();
  const parsed = text ? safeJson(text) : {};
  if (!response.ok) {
    const err = parsed as { error?: string; detail?: string };
    throw new ApiError(err.error ?? 'SERVER_ERROR', response.status, err.detail);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, payload?: unknown) => call<T>('POST', url, payload ?? {}),
  patch: <T>(url: string, payload: unknown) => call<T>('PATCH', url, payload),
  del: <T>(url: string) => call<T>('DELETE', url),
};

/** Человеческие подписи к кодам ошибок. Неизвестный код показываем как есть. */
export const ERRORS: Record<string, string> = {
  UNAUTHORIZED: 'Telegram не подтвердил вход',
  DB_NOT_CONFIGURED: 'База не подключена — заполни DATABASE_URL',
  SERVER_ERROR: 'Сервер не ответил',
  FORBIDDEN: 'Недостаточно прав',
  NAME_REQUIRED: 'Нужно название',
  TEXT_REQUIRED: 'Нужен текст',
  PLATFORMS_REQUIRED: 'Выбери хотя бы одну площадку',
  NOT_APPROVED: 'Сначала нужно одобрение человека',
  CONTENT_CHANGED: 'Текст изменился после одобрения — нужно одобрить заново',
  ALREADY_SCHEDULED: 'Эта версия уже в очереди',
  ALREADY_DECIDED: 'Решение уже принято',
  ALREADY_SENT: 'Публикация уже ушла',
  NO_ACCOUNT: 'Для этой площадки нет подключённого аккаунта',
  NO_METRICS: 'Введи хотя бы одно число',
  INVALID_CODE: 'Такого кода нет',
  CODE_USED: 'Код уже использован',
  CODE_EXPIRED: 'Срок кода истёк',
  ALREADY_MEMBER: 'Ты уже в этом пространстве',
  AI_UNAVAILABLE: 'Модель не подключена — правку сделай руками',
  AI_REFUSED: 'Модель отказалась работать с этим материалом',
  NO_TOKEN_KEY: 'PULSE_TOKEN_KEY не задан — токен негде зашифровать',
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return ERRORS[e.code] ?? e.detail ?? e.code;
  return e instanceof Error ? e.message : 'Что-то пошло не так';
}
