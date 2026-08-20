import type { Platform } from '../types';
import { aiProvider, AiError } from './provider';
import {
  PACK_SYSTEM,
  PLATFORM_SPECS,
  REWRITE_SCHEMA,
  brandContext,
  packPrompt,
  packSchema,
  rewritePrompt,
  type PackInput,
  type RewriteAction,
} from './prompts';
import type { BrandProfile } from '../types';
import { checkQuality, type QualityFinding } from './quality';

export type DraftVariant = {
  platform: Platform;
  firstHook: string;
  body: string;
  cta: string;
  hashtags: string[];
  notes: string;
  findings: QualityFinding[];
};

export type GeneratedPack = {
  title: string;
  hypothesis: string;
  variants: DraftVariant[];
  /** Имя модели или 'offline' — человек должен знать, кто это написал. */
  producedBy: string;
};

type RawVariant = {
  platform?: string;
  firstHook?: string;
  body?: string;
  cta?: string;
  hashtags?: string[];
  notes?: string;
};

type RawPack = {
  title?: string;
  hypothesis?: string;
  variants?: RawVariant[];
};

/**
 * Из одной идеи — набор самостоятельных материалов.
 * Без ключа модели путь не обрывается: собираем честный офлайн-черновик,
 * помечаем его и отдаём человеку на правку.
 */
export async function generatePack(input: PackInput): Promise<GeneratedPack> {
  const provider = aiProvider();
  if (!provider) return offlinePack(input);

  const raw = await provider.json<RawPack>({
    system: PACK_SYSTEM,
    prompt: packPrompt(input),
    schema: packSchema(input.platforms),
    effort: 'high',
  });

  const byPlatform = new Map<Platform, RawVariant>();
  for (const v of raw.variants ?? []) {
    const platform = v.platform as Platform;
    if (input.platforms.includes(platform)) byPlatform.set(platform, v);
  }

  const variants: DraftVariant[] = input.platforms.map((platform) => {
    const v = byPlatform.get(platform);
    // модель пропустила площадку — не выдумываем за неё, отдаём офлайн-черновик
    if (!v?.body?.trim()) return offlineVariant(platform, input);

    const draft: Omit<DraftVariant, 'findings'> = {
      platform,
      firstHook: (v.firstHook ?? '').trim(),
      body: (v.body ?? '').trim(),
      cta: (v.cta ?? input.brand?.defaultCta ?? '').trim(),
      hashtags: (v.hashtags ?? []).slice(0, 5),
      notes: (v.notes ?? '').trim(),
    };
    return { ...draft, findings: findingsFor(draft, input) };
  });

  return {
    title: (raw.title ?? '').trim() || fallbackTitle(input.sourceText),
    hypothesis: (raw.hypothesis ?? '').trim(),
    variants,
    producedBy: provider.name,
  };
}

/** Точечная правка одной версии по кнопке редактора. */
export async function rewriteVariant(args: {
  action: RewriteAction;
  platform: Platform;
  brand: BrandProfile | null;
  firstHook: string;
  body: string;
  cta: string;
}): Promise<{ firstHook: string; body: string; cta: string; producedBy: string }> {
  const provider = aiProvider();
  if (!provider) {
    throw new AiError('AI_UNAVAILABLE', 'Модель не подключена — правку сделай руками');
  }

  const result = await provider.json<{ firstHook?: string; body?: string; cta?: string }>({
    system: PACK_SYSTEM,
    prompt: rewritePrompt({ ...args, spec: PLATFORM_SPECS[args.platform] }),
    schema: REWRITE_SCHEMA,
    effort: 'medium',
  });

  return {
    firstHook: (result.firstHook ?? args.firstHook).trim(),
    body: (result.body ?? args.body).trim(),
    cta: (result.cta ?? args.cta).trim(),
    producedBy: provider.name,
  };
}

// ─────────────────────────────────────────────────────────────
// Офлайн-черновик.
//
// Не изображает модель и не выдумывает фактов: раскладывает саму идею
// по правилам площадки, чтобы весь путь до публикации работал без ключа.
// ─────────────────────────────────────────────────────────────

export function offlinePack(input: PackInput): GeneratedPack {
  return {
    title: fallbackTitle(input.sourceText),
    hypothesis: 'Гипотеза не сформулирована: модель не подключена.',
    variants: input.platforms.map((p) => offlineVariant(p, input)),
    producedBy: 'offline',
  };
}

function offlineVariant(platform: Platform, input: PackInput): DraftVariant {
  const spec = PLATFORM_SPECS[platform];
  const sentences = input.sourceText
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const firstHook = clamp(sentences[0] ?? input.sourceText.trim(), 180);
  const rest = sentences.slice(1).join(' ').trim();
  const cta = input.brand?.defaultCta ?? '';

  let body: string;
  switch (platform) {
    case 'threads':
      body = [firstHook, '---', clamp(rest || firstHook, 460)]
        .filter(Boolean)
        .join('\n');
      break;
    case 'tiktok':
      body = [
        'Первый кадр: [опиши, что видно в первую секунду]',
        `Первая фраза: ${firstHook}`,
        '',
        rest ? `Реплики: ${clamp(rest, 700)}` : 'Реплики: [дописать]',
        '',
        'Монтаж: [склейка на смене мысли]',
      ].join('\n');
      break;
    case 'instagram':
      body = [clamp(rest || firstHook, 800), cta].filter(Boolean).join('\n\n');
      break;
    default:
      body = [clamp(rest || firstHook, spec.softLimit), cta].filter(Boolean).join('\n\n');
  }

  const draft: Omit<DraftVariant, 'findings'> = {
    platform,
    firstHook,
    body,
    cta,
    hashtags: [],
    notes: 'Собрано без модели: это раскладка идеи по формату, а не готовый текст.',
  };
  return { ...draft, findings: findingsFor(draft, input) };
}

function findingsFor(
  draft: Omit<DraftVariant, 'findings'>,
  input: PackInput,
): QualityFinding[] {
  return checkQuality({
    platform: draft.platform,
    firstHook: draft.firstHook,
    body: draft.body,
    cta: draft.cta,
    brand: input.brand,
    recentHooks: input.recentHooks,
  });
}

function fallbackTitle(source: string): string {
  const first = source.trim().split(/\s+/).slice(0, 8).join(' ');
  return clamp(first || 'Без названия', 60);
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

export { brandContext };
