import type { ItemType } from './types';

/**
 * Временная замена разбору через Claude API (п. 3 спеки).
 * Правила взяты из прототипа дословно — это заглушка, а не продукт:
 * когда подключим ИИ, весь этот файл уходит целиком.
 */
export function classify(raw: string): ItemType {
  const s = raw.toLowerCase();
  if (/^https?:\/\//.test(s)) return 'wish';
  if (/хочу|хотел|мечта|подар|желаю|съезд/.test(s)) return 'wish';
  if (/купи|кончил|заканчива|молок|корм|порошок|заказать/.test(s)) return 'home';
  return 'task';
}

export function firstUrl(raw: string): string | null {
  const m = raw.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

/** Домен человек должен видеть всегда — иначе непонятно, откуда вещь. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
