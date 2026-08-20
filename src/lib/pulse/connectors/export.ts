import type { ContentPack, Platform } from '../types';
import { PLATFORM_SPECS } from '../ai/prompts';
import { renderBody } from './types';

/**
 * Экспорт-пакет для неподключённой площадки.
 *
 * Правило 10 из ТЗ: если публиковать сами не можем — отдаём готовый пакет
 * одним файлом и напоминание. Человек не должен собирать это руками
 * по кусочкам из разных экранов.
 */

export type ExportFile = { name: string; content: string };

export type ExportPackage = {
  fileName: string;
  files: ExportFile[];
};

export function buildExportPackage(pack: ContentPack, projectName: string): ExportPackage {
  const files: ExportFile[] = [];
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = slugify(pack.item.title || pack.item.sourceText) || 'pack';

  files.push({
    name: 'README.md',
    content: readme(pack, projectName, stamp),
  });

  for (const variant of pack.variants) {
    const spec = PLATFORM_SPECS[variant.platform];
    const text = renderBody(variant);
    const lines = [
      `# ${spec.label} — ${pack.item.title || 'без названия'}`,
      '',
      `Формат: ${variant.kind}. Знаков: ${text.length} (мягкий предел ${spec.softLimit}).`,
      '',
      '## Первая строка',
      variant.firstHook || '—',
      '',
      '## Текст',
      text,
      '',
      '## Призыв',
      variant.cta || '—',
    ];

    const hashtags = variant.metadata?.hashtags;
    if (Array.isArray(hashtags) && hashtags.length) {
      lines.push('', '## Хэштеги', hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' '));
    }

    files.push({ name: `${variant.platform}.md`, content: lines.join('\n') });
  }

  // машинно читаемая копия — чтобы пакет можно было залить скриптом
  files.push({
    name: 'pack.json',
    content: JSON.stringify(
      {
        project: projectName,
        title: pack.item.title,
        objective: pack.item.objective,
        audience: pack.item.audience,
        exportedAt: new Date().toISOString(),
        variants: pack.variants.map((v) => ({
          platform: v.platform,
          kind: v.kind,
          firstHook: v.firstHook,
          body: v.body,
          cta: v.cta,
          metadata: v.metadata,
        })),
      },
      null,
      2,
    ),
  });

  return { fileName: `pulse-${slug}-${stamp}`, files };
}

function readme(pack: ContentPack, projectName: string, stamp: string): string {
  const platforms = pack.variants.map((v) => PLATFORM_SPECS[v.platform].label).join(', ');
  return [
    `# ${pack.item.title || 'Пакет материалов'}`,
    '',
    `Проект: ${projectName}`,
    `Дата: ${stamp}`,
    `Площадки: ${platforms}`,
    '',
    '## Исходная идея',
    pack.item.sourceText,
    '',
    '## Что делать',
    '1. Открой файл нужной площадки.',
    '2. Загрузи текст и медиа руками.',
    '3. Вернись в PULSE и отметь публикацию — иначе аналитика не свяжет результат с материалом.',
    '',
    'Пакет собран автоматически. Ничего не публикуется без явного одобрения человека.',
  ].join('\n');
}

/**
 * Один текстовый файл вместо архива: zip внутри Mini App человеку неудобно,
 * а собрать архив на клиенте нечем. Разделители явные, файл читается глазами.
 */
export function flattenPackage(pkg: ExportPackage): string {
  return pkg.files
    .map((f) => `${'='.repeat(60)}\n=== ${f.name}\n${'='.repeat(60)}\n\n${f.content}`)
    .join('\n\n');
}

export function platformsNeedingExport(platforms: Platform[]): Platform[] {
  return platforms.filter((p) => p !== 'telegram');
}

function slugify(text: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ы: 'y', э: 'e', ю: 'yu', я: 'ya', ъ: '', ь: '',
  };
  return text
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
