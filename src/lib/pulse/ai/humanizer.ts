/**
 * Humanizer.
 *
 * Ловит следы генерации, которые видно без модели: клише, канцелярит,
 * симметричные противопоставления, ровный ритм. Это дешёвая проверка,
 * она бежит на каждое сохранение — модель зовём только когда человек
 * сам нажал «Убрать ИИ-тон».
 */

export type HumanizerFinding = {
  code: string;
  message: string;
  /** Что именно нашли — показываем человеку, а не абстрактный код. */
  sample: string;
};

const CLICHE = [
  'в современном мире',
  'в наше время',
  'в эпоху цифровизации',
  'не секрет, что',
  'важно отметить, что',
  'стоит отметить, что',
  'таким образом',
  'в конечном счёте',
  'в конечном итоге',
  'играет ключевую роль',
  'является неотъемлемой частью',
  'откроет новые горизонты',
  'выведет на новый уровень',
  'погрузимся в',
  'давайте разберёмся',
];

const BUREAUCRATIC = [
  'осуществляется',
  'осуществление',
  'реализация',
  'реализуется',
  'является',
  'данный',
  'вышеуказанн',
  'в целях',
  'в рамках',
  'посредством',
  'обеспечивает возможность',
  'на сегодняшний день',
];

const EMPTY_PROMISE = [
  'изменит вашу жизнь',
  'революция в',
  'уникальная возможность',
  'секрет успеха',
  'всего за пару кликов',
  'гарантированный результат',
];

export function humanize(text: string): HumanizerFinding[] {
  const findings: HumanizerFinding[] = [];
  const lower = text.toLowerCase();

  for (const phrase of CLICHE) {
    if (lower.includes(phrase)) {
      findings.push({ code: 'CLICHE', message: 'Клише', sample: phrase });
    }
  }

  for (const stem of BUREAUCRATIC) {
    if (lower.includes(stem)) {
      findings.push({ code: 'BUREAUCRATIC', message: 'Канцелярит', sample: stem });
    }
  }

  for (const phrase of EMPTY_PROMISE) {
    if (lower.includes(phrase)) {
      findings.push({ code: 'EMPTY_PROMISE', message: 'Пустое обещание', sample: phrase });
    }
  }

  // «не X, а Y» — любимая симметрия генерации.
  // Границу слова ищем через отсутствие буквы: \b в JS знает только латиницу
  // и на кириллице молча не срабатывает.
  const contrast = text.match(/(?:^|[^\p{L}])не\s+[^,.!?]{3,40},\s*а\s+[^,.!?]{3,40}/giu) ?? [];
  if (contrast.length >= 2) {
    findings.push({
      code: 'FAKE_CONTRAST',
      message: 'Искусственные противопоставления «не X, а Y» подряд',
      sample: contrast.slice(0, 2).join(' / '),
    });
  }

  const dashes = (text.match(/—/g) ?? []).length;
  const sentences = splitSentences(text);
  if (dashes > 2 && sentences.length > 0 && dashes / sentences.length > 0.5) {
    findings.push({
      code: 'DASH_OVERUSE',
      message: `Слишком много длинных тире: ${dashes} на ${sentences.length} предложений`,
      sample: '—',
    });
  }

  // одинаковые по длине абзацы — ритм, который выдаёт генерацию
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length >= 3) {
    const lengths = paragraphs.map((p) => p.length);
    if (spread(lengths) < 0.12) {
      findings.push({
        code: 'FLAT_RHYTHM',
        message: 'Абзацы одинаковой длины — текст звучит ровно и неживо',
        sample: lengths.join(' / '),
      });
    }
  }

  // тот же ровный ритм на уровне предложений
  if (sentences.length >= 5) {
    const lengths = sentences.map((s) => s.length);
    if (spread(lengths) < 0.18) {
      findings.push({
        code: 'FLAT_SENTENCES',
        message: 'Предложения одинаковой длины — не хватает живой интонации',
        sample: lengths.slice(0, 5).join(' / '),
      });
    }
  }

  // повтор одного и того же начала абзаца
  const openings = paragraphs.map((p) => firstWords(p, 2)).filter(Boolean);
  const repeated = openings.find((o, i) => openings.indexOf(o) !== i);
  if (repeated) {
    findings.push({
      code: 'REPEATED_OPENING',
      message: 'Абзацы начинаются одинаково',
      sample: repeated,
    });
  }

  return dedupe(findings);
}

/** Коэффициент разброса длин: 0 — всё одинаковое, больше — живее. */
function spread(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 1;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

function firstWords(text: string, count: number): string {
  return text
    .toLowerCase()
    .split(/\s+/)
    .slice(0, count)
    .join(' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '');
}

function dedupe(findings: HumanizerFinding[]): HumanizerFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.code}:${f.sample}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
