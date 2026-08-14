import type { BrandProfile, Platform } from '../types';
import { PLATFORM_SPECS } from './prompts';
import { humanize, splitSentences } from './humanizer';

/**
 * Проверка качества перед отправкой (раздел 9.4 ТЗ).
 *
 * Семь вопросов к материалу. Часть из них проверяется программно и честно —
 * длина, повторы, число призывов, запрещённые формулировки. Часть требует
 * человека, и мы это прямо говорим, а не изображаем уверенность.
 */

export type CheckLevel = 'block' | 'warn' | 'ask';

export type QualityFinding = {
  code: string;
  level: CheckLevel;
  message: string;
};

export type QualityInput = {
  platform: Platform;
  firstHook: string;
  body: string;
  cta: string;
  brand: BrandProfile | null;
  /** Первые строки недавних публикаций проекта. */
  recentHooks?: string[];
};

export function checkQuality(input: QualityInput): QualityFinding[] {
  const spec = PLATFORM_SPECS[input.platform];
  const findings: QualityFinding[] = [];
  const full = `${input.firstHook}\n\n${input.body}`.trim();

  // 1. Понятна ли первая строка без контекста
  const hook = input.firstHook.trim();
  if (!hook) {
    findings.push({ code: 'NO_HOOK', level: 'block', message: 'Нет первой строки' });
  } else {
    if (hook.length < 15) {
      findings.push({
        code: 'HOOK_TOO_SHORT',
        level: 'warn',
        message: 'Первая строка слишком короткая, чтобы нести мысль',
      });
    }
    // \b в JS не работает на кириллице — границу ищем как «дальше не буква»
    if (/^(итак|ну|в общем|короче|друзья|всем привет)(?![\p{L}])/iu.test(hook)) {
      findings.push({
        code: 'HOOK_WARMUP',
        level: 'warn',
        message: 'Первая строка — разгон, а не мысль',
      });
    }
    if (/^(это|он|она|они|тут|там)(?![\p{L}])/iu.test(hook)) {
      findings.push({
        code: 'HOOK_DANGLING',
        level: 'warn',
        message: 'Первая строка начинается с отсылки к тому, чего читатель не видел',
      });
    }
  }

  // 2. Одна конкретная мысль
  if (input.body.trim().length < 40) {
    findings.push({ code: 'BODY_EMPTY', level: 'block', message: 'Текст почти пустой' });
  }

  // 4. Соответствие площадке
  if (full.length > spec.hardLimit) {
    findings.push({
      code: 'OVER_HARD_LIMIT',
      level: 'block',
      message: `${full.length} знаков при жёстком пределе ${spec.hardLimit} для ${spec.label}`,
    });
  } else if (full.length > spec.softLimit) {
    findings.push({
      code: 'OVER_SOFT_LIMIT',
      level: 'warn',
      message: `${full.length} знаков — длиннее, чем работает на ${spec.label} (${spec.softLimit})`,
    });
  }

  if (input.platform === 'threads') {
    const posts = input.body.split(/^\s*---\s*$/m).map((p) => p.trim()).filter(Boolean);
    const tooLong = posts.filter((p) => p.length > 500);
    if (tooLong.length) {
      findings.push({
        code: 'THREAD_POST_TOO_LONG',
        level: 'block',
        message: `В ветке ${tooLong.length} пост(ов) длиннее 500 знаков`,
      });
    }
  }

  // 6. Один основной призыв
  const ctas = countCtas(full, input.cta);
  if (!input.cta.trim()) {
    findings.push({ code: 'NO_CTA', level: 'warn', message: 'Призыв не задан' });
  } else if (ctas > 1) {
    findings.push({
      code: 'MANY_CTAS',
      level: 'warn',
      message: `Похоже, призывов больше одного (${ctas})`,
    });
  }

  // 5. Повтор недавних публикаций
  for (const recent of input.recentHooks ?? []) {
    if (similar(hook, recent)) {
      findings.push({
        code: 'REPEATS_RECENT',
        level: 'warn',
        message: `Первая строка почти повторяет недавнюю: «${trim(recent, 60)}»`,
      });
      break;
    }
  }

  // Запрещённые формулировки бренда — это не рекомендация
  for (const phrase of input.brand?.prohibitedPhrases ?? []) {
    if (phrase.trim() && full.toLowerCase().includes(phrase.trim().toLowerCase())) {
      findings.push({
        code: 'PROHIBITED_PHRASE',
        level: 'block',
        message: `Запрещённая формулировка: «${phrase}»`,
      });
    }
  }

  // 3. Подтверждены ли цифры и внешние факты
  const numbers = full.match(/\d+(?:[.,]\d+)?\s*%?/g) ?? [];
  const known = (input.brand?.facts ?? []).map((f) => f.claim.toLowerCase()).join(' ');
  const unverified = numbers.filter((n) => !known.includes(n.trim().toLowerCase()));
  if (unverified.length) {
    findings.push({
      code: 'UNVERIFIED_NUMBERS',
      level: 'ask',
      message: `Проверь цифры глазами: ${unverified.slice(0, 5).join(', ')} — их нет в фактах проекта`,
    });
  }
  const links = full.match(/https?:\/\/\S+/g) ?? [];
  if (links.length) {
    findings.push({
      code: 'CHECK_LINKS',
      level: 'ask',
      message: `Проверь ссылки: ${links.slice(0, 3).join(', ')}`,
    });
  }

  // 7. Можно ли произнести вслух без спотыкания
  const long = splitSentences(full).filter((s) => s.split(/\s+/).length > 35);
  if (long.length) {
    findings.push({
      code: 'HARD_TO_SAY',
      level: 'warn',
      message: `${long.length} предложени(е/я) длиннее 35 слов — вслух не читается`,
    });
  }

  // следы генерации
  for (const finding of humanize(full)) {
    findings.push({
      code: `HUMANIZER_${finding.code}`,
      level: 'warn',
      message: `${finding.message}: «${trim(finding.sample, 50)}»`,
    });
  }

  return findings;
}

/** Есть ли то, что обязано остановить отправку. */
export function hasBlockers(findings: QualityFinding[]): boolean {
  return findings.some((f) => f.level === 'block');
}

function countCtas(text: string, cta: string): number {
  const patterns = [
    /подпис(ыва|ать|ись|ку)/i,
    /перех(оди|од)/i,
    /напиш(и|ите)/i,
    /жм(и|ите)/i,
    /закаж(и|ите)/i,
    /запиш(ись|итесь)/i,
    /ссылк[аеу] в/i,
    /перейти в/i,
  ];
  let count = patterns.filter((p) => p.test(text)).length;
  if (cta.trim() && !text.toLowerCase().includes(cta.trim().toLowerCase())) count += 1;
  return count;
}

/** Грубое сравнение по общим словам: хватает, чтобы поймать пересказ. */
function similar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size < 3 || wb.size < 3) return false;
  let shared = 0;
  wa.forEach((w) => {
    if (wb.has(w)) shared += 1;
  });
  return shared / Math.min(wa.size, wb.size) > 0.6;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
