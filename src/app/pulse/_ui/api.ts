'use client';

/**
 * Единственный способ, которым экран разговаривает с сервером.
 * initData добывается один раз и прикладывается ко всем запросам —
 * сервер проверяет подпись и берёт tg_id только оттуда.
 */

/**
 * Достаём initData ровно один раз и разделяем один промис на всех.
 *
 * Флаг «уже сделано» до await не годится: экран и провайдер стартуют
 * одновременно, второй вызывающий получил бы undefined и ушёл бы
 * запросом без заголовка — то есть 401 на ровном месте.
 */
let pending: Promise<string | undefined> | null = null;

export function ensureInitData(): Promise<string | undefined> {
  if (!pending) {
    pending = (async () => {
      try {
        const sdk = await import('@telegram-apps/sdk-react');
        if (!sdk.isTMA()) return undefined;
        sdk.init();
        return sdk.retrieveRawInitData();
      } catch {
        // браузер вне Telegram: работаем через dev-вход, если он включён
        return undefined;
      }
    })();
  }
  return pending;
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

/** Генерация может думать минуты, остальное — нет. */
const TIMEOUT_MS = 180_000;

async function call<T>(method: string, url: string, payload?: unknown): Promise<T> {
  const initData = await ensureInitData();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (initData) headers['x-telegram-init-data'] = initData;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      // без предела зависший запрос оставляет экран в «работаем…» навсегда
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === 'TimeoutError';
    throw new ApiError(timedOut ? 'TIMEOUT' : 'NETWORK', 0);
  }

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
  NETWORK: 'Нет связи с сервером',
  TIMEOUT: 'Сервер думает слишком долго — попробуй ещё раз',
  BAD_ID: 'Неверный адрес',
  PROJECT_REQUIRED: 'Не выбран проект',
  QUALITY_BLOCKED: 'Проверка качества не пропускает — посмотри замечания',
  VARIANT_LOCKED: 'Эта версия уже одобрена или в очереди',
  VARIANT_NOT_EDITABLE: 'Опубликованное править нельзя',
  ALREADY_GENERATING: 'Генерация уже идёт',
  EXPORT_ONLY_PLATFORM: 'Эта площадка публикуется вручную — скачай пакет',
  EMPTY_BODY: 'Текст пустой',
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
  if (!(e instanceof ApiError)) {
    return e instanceof Error ? e.message : 'Что-то пошло не так';
  }
  const known = ERRORS[e.code];
  // подробность с сервера не теряем: в ней перечислено, что именно не так
  if (known) return e.detail ? `${known}: ${e.detail}` : known;
  return e.detail ?? e.code;
}
