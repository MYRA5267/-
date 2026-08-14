import type { ErrorStatus, Platform } from '../types';

/**
 * Каждая площадка — отдельный модуль с этим интерфейсом.
 * Изменение одного API не должно ломать всю систему.
 */

export type PublishAsset = {
  kind: 'image' | 'video' | 'document' | 'audio';
  url: string;
  mimeType?: string | null;
};

export type PublishPayload = {
  platform: Platform;
  /** Куда публикуем: @канал, id чата, id аккаунта площадки. */
  externalAccountId: string;
  /** Расшифрованный токен. Для Telegram может быть null — берём токен бота. */
  token: string | null;
  firstHook: string;
  body: string;
  cta: string;
  assets: PublishAsset[];
  metadata: Record<string, unknown>;
  /** Ключ идемпотентности задачи — уходит в лог, чтобы связать попытки. */
  idempotencyKey: string;
};

export type PublishOk = {
  ok: true;
  externalPostId: string;
  externalUrl: string | null;
  publishedAt: string;
};

export type PublishFail = {
  ok: false;
  status: ErrorStatus;
  code: string;
  message: string;
  /** Когда можно повторить. null — повторять бессмысленно. */
  retryAfterMs: number | null;
};

export type PublishResult = PublishOk | PublishFail;

export type Connector = {
  platform: Platform;
  /** Публикует ли модуль сам, или только собирает пакет для человека. */
  autoPublish: boolean;
  publish(payload: PublishPayload): Promise<PublishResult>;
  /** Проверка доступа без публикации. */
  test(payload: Pick<PublishPayload, 'externalAccountId' | 'token'>): Promise<PublishResult | { ok: true; info: string }>;
};

/** Собирает полный текст версии так, как он уйдёт на площадку. */
export function renderBody(payload: Pick<PublishPayload, 'firstHook' | 'body' | 'cta'>): string {
  const hook = payload.firstHook.trim();
  const body = payload.body.trim();
  const cta = payload.cta.trim();

  const parts: string[] = [];
  // крючок не дублируем, если он уже начинает текст
  if (hook && !body.startsWith(hook)) parts.push(hook);
  if (body) parts.push(body);
  if (cta && !body.includes(cta)) parts.push(cta);
  return parts.join('\n\n');
}

export function retryDelayMs(attempt: number): number {
  // 1м, 4м, 9м, 16м, 25м — растёт быстро, но без внезапных суток
  const minutes = Math.min(60, (attempt + 1) ** 2);
  return minutes * 60_000;
}

export const MAX_ATTEMPTS = 5;
