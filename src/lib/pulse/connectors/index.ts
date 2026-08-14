import type { Platform } from '../types';
import type { Connector, PublishPayload, PublishResult } from './types';
import { telegramConnector } from './telegram';

/**
 * Реестр площадок.
 *
 * Честно про уровень автоматизации: полностью работает Telegram.
 * Threads, Instagram и TikTok в MVP готовят материал и отдают пакет
 * для ручной загрузки — обещать публичный автопостинг в первый день
 * нельзя, пока не выданы production-доступы и не пройден аудит.
 */

function exportOnly(platform: Platform, why: string): Connector {
  return {
    platform,
    autoPublish: false,
    async publish(): Promise<PublishResult> {
      return {
        ok: false,
        status: 'AUTH_REQUIRED',
        code: 'EXPORT_ONLY',
        message: why,
        retryAfterMs: null,
      };
    },
    async test() {
      return {
        ok: false,
        status: 'AUTH_REQUIRED',
        code: 'EXPORT_ONLY',
        message: why,
        retryAfterMs: null,
      };
    },
  };
}

const CONNECTORS: Record<Platform, Connector> = {
  telegram: telegramConnector,
  threads: exportOnly(
    'threads',
    'Threads подключается через Meta OAuth. До выдачи production-доступа материал уходит в экспорт-пакет.',
  ),
  instagram: exportOnly(
    'instagram',
    'Instagram публикует только через официальный API после App Review. Пока — экспорт-пакет.',
  ),
  tiktok: exportOnly(
    'tiktok',
    'TikTok Direct Post включается после одобрения video.publish и аудита приложения. Пока — экспорт-пакет и ручное подтверждение.',
  ),
};

export function connectorFor(platform: Platform): Connector {
  return CONNECTORS[platform];
}

export function canAutoPublish(platform: Platform): boolean {
  return CONNECTORS[platform].autoPublish;
}

export type { Connector, PublishPayload, PublishResult };
