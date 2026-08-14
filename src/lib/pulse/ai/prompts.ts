import type { BrandProfile, Objective, Platform, VariantKind } from '../types';
import { OBJECTIVE_LABEL } from '../types';

/**
 * Правила площадок. Не «размножить текст по кнопке»: у каждой площадки
 * своя механика, свой первый экран и своя причина, по которой человек
 * останавливает палец.
 */
export type PlatformSpec = {
  platform: Platform;
  kind: VariantKind;
  label: string;
  /** Мягкий предел: за ним текст перестаёт работать, даже если проходит по API. */
  softLimit: number;
  /** Жёсткий предел площадки. */
  hardLimit: number;
  brief: string;
};

export const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  telegram: {
    platform: 'telegram',
    kind: 'post',
    label: 'Telegram',
    softLimit: 900,
    hardLimit: 4096,
    brief: [
      'Канальный пост для людей, которые уже подписаны и ждут смысла, а не знакомства.',
      'Первая строка — самостоятельная мысль, её видно в превью уведомления.',
      'Вывод глубже, чем в других версиях: здесь можно договорить до конца.',
      'Абзацы короткие, между ними пустая строка. Без заголовков-«шапок» и без хэштегов.',
    ].join(' '),
  },
  threads: {
    platform: 'threads',
    kind: 'thread',
    label: 'Threads',
    softLimit: 480,
    hardLimit: 500,
    brief: [
      'Разговорная ветка. Первый пост — крючок до 200 знаков, дальше 2–4 продолжения.',
      'Каждый пост ветки читается сам по себе и заканчивается так, чтобы хотелось листать.',
      'Тон устный, как реплика в разговоре. Разделяй посты строкой «---».',
      'Каждый пост не длиннее 500 знаков — это жёсткий предел площадки.',
    ].join(' '),
  },
  instagram: {
    platform: 'instagram',
    kind: 'caption',
    label: 'Instagram',
    softLimit: 900,
    hardLimit: 2200,
    brief: [
      'Подпись под пост или Reels. Видно только первые ~125 знаков до «ещё» —',
      'в них должна быть законченная мысль, а не разгон.',
      'Дальше 2–4 коротких абзаца и один переход. Хэштеги отдельно, до 5 штук, по делу.',
    ].join(' '),
  },
  tiktok: {
    platform: 'tiktok',
    kind: 'script',
    label: 'TikTok',
    softLimit: 1200,
    hardLimit: 2200,
    brief: [
      'Сценарий короткого видео. Формат: первый кадр (что видно), первая фраза (что слышно),',
      'дальше реплики по 1–2 предложения с монтажными подсказками в квадратных скобках.',
      'Первое предложение обязано отличаться от версий для других площадок.',
      'В конце — подпись к видео и до 5 хэштегов.',
    ].join(' '),
  },
};

/** Reels отличается от Instagram-подписи механикой, но живёт на той же площадке. */
export const REELS_BRIEF = [
  'Сценарий Reels: первый кадр, первая фраза, реплики, монтажные подсказки.',
  'Первые 3 секунды решают всё — начинай с конфликта или конкретной цифры.',
].join(' ');

export type PackInput = {
  sourceText: string;
  objective: Objective;
  audience: string;
  platforms: Platform[];
  brand: BrandProfile | null;
  /** Недавние публикации проекта: чтобы не повторять то же самое. */
  recentHooks: string[];
};

/**
 * Brand Brain в виде текста. Всё, что модель обязана знать про проект,
 * собирается здесь и нигде больше — данные одного клиента не должны
 * случайно попасть в контекст другого.
 */
export function brandContext(brand: BrandProfile | null): string {
  if (!brand) return 'Бренд-контекст не заполнен. Пиши нейтрально и без выдуманных фактов.';

  const lines: string[] = [];
  if (brand.positioning) lines.push(`Позиционирование: ${brand.positioning}`);
  if (brand.audiences.length) lines.push(`Аудитория: ${brand.audiences.join('; ')}`);

  const voice = brand.voice ?? {};
  const voiceBits: string[] = [];
  if (voice.tone) voiceBits.push(`тон — ${voice.tone}`);
  if (voice.humor) voiceBits.push(`юмор — ${voice.humor}`);
  if (voice.emoji) {
    voiceBits.push(
      `эмодзи — ${voice.emoji === 'none' ? 'не используем' : voice.emoji === 'rare' ? 'редко и к месту' : 'свободно'}`,
    );
  }
  if (voice.length) {
    voiceBits.push(
      `длина — ${voice.length === 'short' ? 'короткая' : voice.length === 'long' ? 'развёрнутая' : 'средняя'}`,
    );
  }
  if (voiceBits.length) lines.push(`Голос: ${voiceBits.join(', ')}`);

  if (brand.prohibitedPhrases.length) {
    lines.push(`Запрещённые формулировки (не использовать ни в каком виде): ${brand.prohibitedPhrases.join('; ')}`);
  }
  if (brand.examples.good.length) {
    lines.push(`Так звучит хорошо:\n${brand.examples.good.map((t) => `— ${t}`).join('\n')}`);
  }
  if (brand.examples.bad.length) {
    lines.push(`Так звучит плохо, не повторять:\n${brand.examples.bad.map((t) => `— ${t}`).join('\n')}`);
  }
  if (brand.facts.length) {
    lines.push(
      `Проверенные факты и цифры — только эти, других не выдумывать:\n${brand.facts
        .map((f) => `— ${f.claim}${f.source ? ` (источник: ${f.source})` : ''}`)
        .join('\n')}`,
    );
  }
  if (brand.defaultCta) lines.push(`Основной призыв: ${brand.defaultCta}`);

  return lines.join('\n');
}

export const PACK_SYSTEM = [
  'Ты редактор контента внутри PULSE Studio. Из одной идеи ты собираешь',
  'самостоятельные материалы под разные площадки.',
  '',
  'Правила, которые важнее любых других:',
  '1. Один и тот же текст, размноженный по площадкам, — брак. Каждая версия',
  '   учитывает механику площадки, формат и цель.',
  '2. Факты, цифры и имена берутся только из бренд-контекста. Ничего не',
  '   выдумывать: если факта нет — писать без него.',
  '3. Один основной призыв на материал, не три.',
  '4. Первая строка понятна без контекста и без предыдущих публикаций.',
  '5. Пиши так, как говорят вслух. Без канцелярита, без «в современном мире»,',
  '   без искусственных противопоставлений «не X, а Y», без пустых обещаний.',
  '6. Ритм живой: предложения разной длины. Одинаково гладкие абзацы выдают',
  '   генерацию.',
  '7. Никаких выдуманных ссылок.',
].join('\n');

export function packPrompt(input: PackInput): string {
  const specs = input.platforms.map((p) => PLATFORM_SPECS[p]);

  const parts = [
    '# Идея',
    input.sourceText.trim(),
    '',
    '# Цель материала',
    OBJECTIVE_LABEL[input.objective],
    '',
    '# Аудитория',
    input.audience.trim() || 'не задана отдельно, ориентируйся на бренд-контекст',
    '',
    '# Бренд-контекст',
    brandContext(input.brand),
    '',
    '# Площадки',
    specs
      .map(
        (s) =>
          `## ${s.label} (${s.platform})\nФормат: ${s.kind}. Мягкий предел ${s.softLimit} знаков, жёсткий ${s.hardLimit}.\n${s.brief}`,
      )
      .join('\n\n'),
  ];

  if (input.recentHooks.length) {
    parts.push(
      '',
      '# Недавние публикации проекта',
      'Не повторяй эти заходы и не пересказывай их другими словами:',
      input.recentHooks.map((h) => `— ${h}`).join('\n'),
    );
  }

  parts.push(
    '',
    '# Что вернуть',
    'Для каждой площадки: первую строку-крючок отдельно, основной текст, один призыв.',
    'Плюс общий заголовок пакета и одну следующую гипотезу — что проверить этим материалом.',
  );

  return parts.join('\n');
}

/** Схема ответа. Строгая: лишние поля не принимаем. */
export function packSchema(platforms: Platform[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'hypothesis', 'variants'],
    properties: {
      title: { type: 'string', description: 'Короткое имя пакета, до 60 знаков' },
      hypothesis: {
        type: 'string',
        description: 'Что именно этот материал проверяет, одним предложением',
      },
      variants: {
        type: 'array',
        minItems: platforms.length,
        maxItems: platforms.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['platform', 'firstHook', 'body', 'cta'],
          properties: {
            platform: { type: 'string', enum: [...platforms] },
            firstHook: { type: 'string', description: 'Первая строка, работает без контекста' },
            body: { type: 'string', description: 'Основной текст версии' },
            cta: { type: 'string', description: 'Один призыв' },
            hashtags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            notes: { type: 'string', description: 'Подсказка редактору, не публикуется' },
          },
        },
      },
    },
  };
}

/** Точечная правка одной версии: кнопки «Усилить хук», «Сжать» и остальные. */
export const REWRITE_ACTIONS = {
  hook: 'Усиль первую строку. Она должна цеплять конкретикой или конфликтом, а не обещанием.',
  alive: 'Сделай живее: разная длина предложений, устная интонация, меньше существительных.',
  shorten: 'Сожми на треть. Сохрани мысль и призыв, убери всё, что не меняет решение читателя.',
  concrete: 'Добавь конкретику: цифры, имена, сроки — но только те, что уже есть в контексте.',
  human: 'Убери ИИ-тон: клише, канцелярит, симметричные конструкции, лишние длинные тире.',
} as const;

export type RewriteAction = keyof typeof REWRITE_ACTIONS;

export function rewritePrompt(args: {
  action: RewriteAction;
  spec: PlatformSpec;
  brand: BrandProfile | null;
  firstHook: string;
  body: string;
  cta: string;
}): string {
  return [
    '# Что сделать',
    REWRITE_ACTIONS[args.action],
    '',
    `# Площадка: ${args.spec.label}`,
    args.spec.brief,
    `Мягкий предел ${args.spec.softLimit} знаков, жёсткий ${args.spec.hardLimit}.`,
    '',
    '# Бренд-контекст',
    brandContext(args.brand),
    '',
    '# Текущая версия',
    `Первая строка: ${args.firstHook}`,
    `Текст:\n${args.body}`,
    `Призыв: ${args.cta}`,
    '',
    'Верни ту же версию целиком, с правкой. Смысл сохрани, факты не добавляй.',
  ].join('\n');
}

export const REWRITE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['firstHook', 'body', 'cta'],
  properties: {
    firstHook: { type: 'string' },
    body: { type: 'string' },
    cta: { type: 'string' },
  },
};
