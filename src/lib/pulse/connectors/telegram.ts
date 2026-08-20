import type { Connector, PublishPayload, PublishResult } from './types';
import { renderBody } from './types';

/**
 * Telegram — единственная площадка, которая в MVP работает целиком:
 * публикация в канал, фото и видео, отложенная очередь на нашей стороне,
 * уведомления и согласование через бота.
 *
 * Бот обязан быть администратором канала с правом публикации.
 * Пароли не запрашиваются и не хранятся: только токен бота.
 */

const API = 'https://api.telegram.org';
const TG_TEXT_LIMIT = 4096;
const TG_CAPTION_LIMIT = 1024;

type TgResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

type TgMessage = {
  message_id: number;
  chat: { id: number; username?: string; title?: string; type: string };
};

function botToken(payload: Pick<PublishPayload, 'token'>): string | null {
  // у канала свой токен не заводится: публикует бот проекта
  return payload.token || process.env.TELEGRAM_BOT_TOKEN || null;
}

/**
 * Экранирование перед отправкой.
 *
 * Telegram в режиме HTML разбирает теги, а экран согласования показывает
 * тот же текст через React, где теги видны буквами. Без экранирования
 * одобряют одно, а в канал уходит другое: написанное автором
 * `<a href="...">` согласующий увидит как текст, а подписчик — как живую
 * ссылку. Плюс любой одиночный «<» в обычном тексте валит отправку с 400
 * и навсегда останавливает публикацию.
 *
 * Поэтому уходит ровно то, что одобрено. Разметка появится отдельным
 * полем, которое видно и в превью.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function call<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TgResponse<T>> {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // площадка иногда думает долго, но не бесконечно
    signal: AbortSignal.timeout(30_000),
  });
  return (await response.json()) as TgResponse<T>;
}

function messageUrl(chat: TgMessage['chat'], messageId: number): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  // приватные каналы: -1001234567890 → t.me/c/1234567890/<id>
  const id = String(chat.id);
  if (id.startsWith('-100')) return `https://t.me/c/${id.slice(4)}/${messageId}`;
  return null;
}

/** Ответ площадки в наш словарь ошибок. Повторять имеет смысл не всё. */
function failure(res: TgResponse<unknown>): PublishResult {
  const code = res.error_code ?? 0;
  const message = res.description ?? 'Telegram отказал без объяснения';

  if (code === 401 || code === 403) {
    return {
      ok: false,
      status: 'AUTH_REQUIRED',
      code: `TG_${code}`,
      message: `${message}. Проверь, что бот админ канала с правом публикации.`,
      retryAfterMs: null,
    };
  }
  if (code === 429) {
    const seconds = res.parameters?.retry_after ?? 30;
    return {
      ok: false,
      status: 'RATE_LIMITED',
      code: 'TG_429',
      message,
      retryAfterMs: seconds * 1000,
    };
  }
  if (code === 400) {
    const media = /photo|video|file|media|url/i.test(message);
    return {
      ok: false,
      status: media ? 'MEDIA_INVALID' : 'PLATFORM_REJECTED',
      code: 'TG_400',
      message,
      retryAfterMs: null,
    };
  }
  // 5xx и всё неизвестное — временная беда, повторим
  return {
    ok: false,
    status: 'FAILED_RETRYABLE',
    code: `TG_${code || 'UNKNOWN'}`,
    message,
    retryAfterMs: null,
  };
}

export const telegramConnector: Connector = {
  platform: 'telegram',
  autoPublish: true,

  async publish(payload: PublishPayload): Promise<PublishResult> {
    const token = botToken(payload);
    if (!token) {
      return {
        ok: false,
        status: 'AUTH_REQUIRED',
        code: 'NO_TOKEN',
        message: 'TELEGRAM_BOT_TOKEN не задан',
        retryAfterMs: null,
      };
    }

    const text = escapeHtml(renderBody(payload));
    const photo = payload.assets.find((a) => a.kind === 'image');
    const video = payload.assets.find((a) => a.kind === 'video');
    const media = video ?? photo;

    // подпись к медиа короче поста: если текст не влезает, шлём его отдельно
    const captionFits = !media || text.length <= TG_CAPTION_LIMIT;

    if (text.length > TG_TEXT_LIMIT) {
      return {
        ok: false,
        status: 'PLATFORM_REJECTED',
        code: 'TOO_LONG',
        message: `${text.length} знаков при пределе Telegram ${TG_TEXT_LIMIT}`,
        retryAfterMs: null,
      };
    }

    try {
      let res: TgResponse<TgMessage>;

      if (media && captionFits) {
        res = await call<TgMessage>(token, video ? 'sendVideo' : 'sendPhoto', {
          chat_id: payload.externalAccountId,
          [video ? 'video' : 'photo']: media.url,
          caption: text,
          parse_mode: 'HTML',
        });
      } else if (media) {
        // сначала медиа без подписи, потом текст ответом на него
        const first = await call<TgMessage>(token, video ? 'sendVideo' : 'sendPhoto', {
          chat_id: payload.externalAccountId,
          [video ? 'video' : 'photo']: media.url,
        });
        if (!first.ok || !first.result) return failure(first);
        res = await call<TgMessage>(token, 'sendMessage', {
          chat_id: payload.externalAccountId,
          text,
          parse_mode: 'HTML',
          reply_to_message_id: first.result.message_id,
          disable_web_page_preview: true,
        });
      } else {
        res = await call<TgMessage>(token, 'sendMessage', {
          chat_id: payload.externalAccountId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      }

      if (!res.ok || !res.result) return failure(res);

      return {
        ok: true,
        externalPostId: String(res.result.message_id),
        externalUrl: messageUrl(res.result.chat, res.result.message_id),
        publishedAt: new Date().toISOString(),
      };
    } catch (e) {
      // сеть моргнула — задача остаётся с тем же ключом идемпотентности
      return {
        ok: false,
        status: 'FAILED_RETRYABLE',
        code: 'NETWORK',
        message: e instanceof Error ? e.message : 'Сеть не ответила',
        retryAfterMs: null,
      };
    }
  },

  async test(payload) {
    const token = botToken(payload);
    if (!token) {
      return {
        ok: false,
        status: 'AUTH_REQUIRED',
        code: 'NO_TOKEN',
        message: 'TELEGRAM_BOT_TOKEN не задан',
        retryAfterMs: null,
      };
    }
    try {
      const res = await call<{ status: string; can_post_messages?: boolean }>(
        token,
        'getChatMember',
        { chat_id: payload.externalAccountId, user_id: await botId(token) },
      );
      if (!res.ok || !res.result) return failure(res);

      const { status, can_post_messages } = res.result;
      const admin = status === 'administrator' || status === 'creator';
      if (!admin) {
        return {
          ok: false,
          status: 'AUTH_REQUIRED',
          code: 'NOT_ADMIN',
          message: 'Бот не администратор канала',
          retryAfterMs: null,
        };
      }
      if (status === 'administrator' && can_post_messages === false) {
        return {
          ok: false,
          status: 'AUTH_REQUIRED',
          code: 'CANNOT_POST',
          message: 'У бота нет права публикации в канале',
          retryAfterMs: null,
        };
      }
      return { ok: true, info: 'Бот админ канала и может публиковать' };
    } catch (e) {
      return {
        ok: false,
        status: 'FAILED_RETRYABLE',
        code: 'NETWORK',
        message: e instanceof Error ? e.message : 'Сеть не ответила',
        retryAfterMs: null,
      };
    }
  },
};

let cachedBotId: number | null = null;

async function botId(token: string): Promise<number> {
  if (cachedBotId) return cachedBotId;
  const res = await call<{ id: number }>(token, 'getMe', {});
  if (!res.ok || !res.result) throw new Error(res.description ?? 'getMe не ответил');
  cachedBotId = res.result.id;
  return cachedBotId;
}

/** Уведомление владельцу: успех, ошибка, запрос на согласование. */
export async function notify(chatId: string | number, text: string): Promise<void> {
  // text приходит уже собранным: вызывающий экранирует подставленные куски
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await call(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch {
    // уведомление не должно ронять публикацию
  }
}
