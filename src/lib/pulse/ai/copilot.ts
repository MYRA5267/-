import type { MetricInput, Platform } from '../types';
import { aiProvider } from './provider';

/**
 * Analytics Copilot.
 *
 * Отвечает не на вопрос «сколько цифр мы собрали», а на вопрос «что делать
 * дальше». Разбиение на три группы — правило первого релиза из ТЗ:
 * верхние 20% повторяем через новый угол, средние 60% улучшаем,
 * нижние 20% останавливаем или переписываем.
 */

export type ScoredPublication = {
  id: string;
  title: string;
  platform: Platform;
  publishedAt: string;
  metrics: MetricInput;
  /** Единая шкала, чтобы сравнивать площадки между собой. */
  score: number;
  band: 'top' | 'middle' | 'bottom';
  verdict: string;
};

export type AnalyticsDigest = {
  best: ScoredPublication | null;
  worst: ScoredPublication | null;
  scored: ScoredPublication[];
  medianScore: number;
  /** Объяснение обычным языком. */
  summary: string;
  nextHypothesis: string;
  producedBy: string;
};

/**
 * Единый показатель материала: охват — знаменатель, вовлечение и переходы —
 * то, ради чего материал делали. Считаем на 1000 просмотров, иначе крупные
 * посты всегда выигрывают у точных.
 */
export function scoreOf(m: MetricInput): number {
  const base = m.views ?? m.reach ?? 0;
  if (!base) return 0;
  const per1000 = (n: number | undefined) => ((n ?? 0) / base) * 1000;

  // веса: сохранение и переход дороже лайка, потому что ближе к результату
  const engagement =
    per1000(m.likes) * 0.5 +
    per1000(m.replies) * 2 +
    per1000(m.reposts) * 3 +
    per1000(m.saves) * 3;
  const intent = per1000(m.profileVisits) * 4 + per1000(m.linkClicks) * 6;
  const retention = (m.completionRate ?? 0) * 20;

  return round(engagement + intent + retention);
}

export function analyze(
  publications: Array<{
    id: string;
    title: string;
    platform: Platform;
    publishedAt: string;
    metrics: MetricInput | null;
  }>,
): AnalyticsDigest {
  const measured = publications.filter((p) => p.metrics && hasNumbers(p.metrics));

  if (measured.length === 0) {
    return {
      best: null,
      worst: null,
      scored: [],
      medianScore: 0,
      summary: 'Метрик пока нет. Введи первые результаты — после этого появится сравнение.',
      nextHypothesis: '',
      producedBy: 'rules',
    };
  }

  const scored: ScoredPublication[] = measured
    .map((p) => {
      const score = scoreOf(p.metrics as MetricInput);
      return {
        id: p.id,
        title: p.title,
        platform: p.platform,
        publishedAt: p.publishedAt,
        metrics: p.metrics as MetricInput,
        score,
        band: 'middle' as const,
        verdict: '',
      };
    })
    .sort((a, b) => b.score - a.score);

  // 20 / 60 / 20 — но на маленькой выборке границы честнее считать по одному
  const topCount = Math.max(1, Math.round(scored.length * 0.2));
  const bottomCount = scored.length > 2 ? Math.max(1, Math.round(scored.length * 0.2)) : 0;

  scored.forEach((item, index) => {
    if (index < topCount) {
      item.band = 'top';
      item.verdict = 'Повторить через новый угол';
    } else if (bottomCount && index >= scored.length - bottomCount) {
      item.band = 'bottom';
      item.verdict = 'Остановить или переписать целиком';
    } else {
      item.band = 'middle';
      item.verdict = 'Улучшить хук, подачу или монтаж';
    }
  });

  const medianScore = median(scored.map((s) => s.score));
  const best = scored[0] ?? null;
  const worst = bottomCount ? scored[scored.length - 1] : null;

  return {
    best,
    worst,
    scored,
    medianScore,
    summary: explain(best, worst, medianScore),
    nextHypothesis: hypothesisFrom(best, worst),
    producedBy: 'rules',
  };
}

/**
 * Тот же разбор, но словами модели. Правила остаются источником решения —
 * модель только объясняет, почему так вышло. Если модели нет, возвращаем
 * правило как есть: пустого экрана человек не увидит.
 */
export async function narrate(digest: AnalyticsDigest, projectName: string): Promise<AnalyticsDigest> {
  const provider = aiProvider();
  if (!provider || !digest.best) return digest;

  const rows = digest.scored
    .slice(0, 10)
    .map(
      (s) =>
        `${s.band.toUpperCase()} · ${s.platform} · «${s.title}» · показатель ${s.score} · ` +
        `просмотры ${s.metrics.views ?? '—'}, сохранения ${s.metrics.saves ?? '—'}, ` +
        `в профиль ${s.metrics.profileVisits ?? '—'}, переходы ${s.metrics.linkClicks ?? '—'}`,
    )
    .join('\n');

  try {
    const result = await provider.json<{ summary?: string; nextHypothesis?: string }>({
      system: [
        'Ты аналитик контента. Объясняешь результат обычным языком: что сработало,',
        'почему и что делать дальше. Не пересказываешь цифры — читатель их видит.',
        'Никаких «вовлечённость выросла на 12%». Одна мысль, один вывод, один шаг.',
        'Не выдумывай данные, которых нет в таблице.',
      ].join(' '),
      prompt: [
        `Проект: ${projectName}`,
        `Медиана показателя по проекту: ${digest.medianScore}`,
        '',
        'Материалы, отсортированы по показателю:',
        rows,
        '',
        'Верни короткое объяснение (2–4 предложения) и одну следующую гипотезу.',
      ].join('\n'),
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'nextHypothesis'],
        properties: {
          summary: { type: 'string' },
          nextHypothesis: { type: 'string' },
        },
      },
      effort: 'medium',
    });

    return {
      ...digest,
      summary: result.summary?.trim() || digest.summary,
      nextHypothesis: result.nextHypothesis?.trim() || digest.nextHypothesis,
      producedBy: provider.name,
    };
  } catch {
    // объяснение — не то, ради чего стоит ронять экран аналитики
    return digest;
  }
}

function explain(
  best: ScoredPublication | null,
  worst: ScoredPublication | null,
  medianScore: number,
): string {
  if (!best) return 'Данных пока мало для выводов.';

  const parts: string[] = [];
  const b = best.metrics;
  const reach = b.views ?? b.reach ?? 0;

  if (reach && (b.profileVisits ?? 0) / reach < 0.01 && (b.saves ?? 0) > 0) {
    parts.push(
      `«${best.title}» читали и сохраняли, но в профиль почти не заходили — ` +
        'заход держим, а продукт показываем раньше и добавляем один конкретный переход.',
    );
  } else if ((b.linkClicks ?? 0) > 0) {
    parts.push(`«${best.title}» довёл людей до перехода — этот угол стоит повторить.`);
  } else {
    parts.push(`Лучший результат недели у «${best.title}».`);
  }

  if (worst) {
    parts.push(
      `Хуже всех «${worst.title}»: показатель ${worst.score} против медианы ${medianScore}. ` +
        'Скорее всего дело в первой строке — её читают до решения смотреть дальше.',
    );
  }

  return parts.join(' ');
}

function hypothesisFrom(best: ScoredPublication | null, worst: ScoredPublication | null): string {
  if (!best) return '';
  if (worst) {
    return `Взять тему «${worst.title}» и переписать её заходом, который сработал в «${best.title}».`;
  }
  return `Повторить угол «${best.title}» на другой теме и сравнить через 72 часа.`;
}

function hasNumbers(m: MetricInput): boolean {
  return Object.values(m).some((v) => typeof v === 'number' && v > 0);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
