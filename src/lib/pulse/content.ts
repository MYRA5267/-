import type { PoolClient } from 'pg';
import { DomainError, assertTouched, withAdmin, withUser } from './db';
import { contentHash } from './crypto';
import { isEditable, isRegeneratable, statusAfterEdit } from './status';
import { logAction, track } from './audit';
import { generatePack, rewriteVariant, type GeneratedPack } from './ai/generate';
import { checkQuality, type QualityFinding } from './ai/quality';
import { PLATFORM_SPECS, type RewriteAction } from './ai/prompts';
import { toBrand } from './projects';
import type {
  BrandProfile,
  ContentPack,
  Idea,
  IdeaState,
  Objective,
  Platform,
  Variant,
  VariantKind,
} from './types';

type IdeaRow = {
  id: string;
  project_id: string;
  title: string;
  source_text: string;
  objective: Objective;
  audience: string;
  status: Idea['status'];
  idea_state: IdeaState;
  created_at: string;
  variant_count?: string;
};

const toIdea = (r: IdeaRow): Idea => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  sourceText: r.source_text,
  objective: r.objective,
  audience: r.audience,
  status: r.status,
  ideaState: r.idea_state,
  createdAt: r.created_at,
  variantCount: Number(r.variant_count ?? 0),
});

type VariantRow = {
  id: string;
  content_item_id: string;
  platform: Platform;
  kind: VariantKind;
  body: string;
  first_hook: string;
  cta: string;
  metadata_json: Record<string, unknown>;
  version: number;
  status: Variant['status'];
  approved_hash: string | null;
};

const toVariant = (r: VariantRow): Variant => ({
  id: r.id,
  contentItemId: r.content_item_id,
  platform: r.platform,
  kind: r.kind,
  body: r.body,
  firstHook: r.first_hook,
  cta: r.cta,
  metadata: r.metadata_json ?? {},
  version: r.version,
  status: r.status,
  approvedHash: r.approved_hash,
});

export async function listIdeas(
  tgId: number | string,
  projectId: string,
  filter?: IdeaState,
): Promise<Idea[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<IdeaRow>(
      `select c.id, c.project_id, c.title, c.source_text, c.objective, c.audience,
              c.status, c.idea_state, c.created_at,
              (select count(*) from pulse.platform_variants v where v.content_item_id = c.id)
                as variant_count
         from pulse.content_items c
        where c.project_id = $1
          and ($2::text is null or c.idea_state = $2)
        order by c.created_at desc
        limit 200`,
      [projectId, filter ?? null],
    );
    return rows.map(toIdea);
  });
}

export async function createIdea(
  tgId: number | string,
  input: {
    projectId: string;
    sourceText: string;
    title?: string;
    objective?: Objective;
    audience?: string;
  },
): Promise<Idea> {
  const sourceText = input.sourceText.trim();
  if (!sourceText) throw new DomainError('TEXT_REQUIRED');

  const idea = await withUser(tgId, async (client) => {
    const { rows } = await client.query<IdeaRow>(
      `insert into pulse.content_items
         (project_id, title, source_text, objective, audience, author_id, status, idea_state)
       values ($1, $2, $3, coalesce($4, 'reach'), coalesce($5, ''), pulse.me(), 'IDEA', 'new')
       returning id, project_id, title, source_text, objective, audience,
                 status, idea_state, created_at`,
      [
        input.projectId,
        (input.title ?? autoTitle(sourceText)).slice(0, 120),
        sourceText,
        input.objective ?? null,
        input.audience ?? null,
      ],
    );
    if (!rows[0]) throw new DomainError('FORBIDDEN', 403);
    return toIdea(rows[0]);
  });

  await withAdmin(async (client) => {
    const ctx = await actorContext(client, tgId, input.projectId);
    if (ctx) {
      await track(client, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: 'idea_created',
      });
    }
  });

  return idea;
}

export async function setIdeaState(
  tgId: number | string,
  contentId: string,
  state: IdeaState,
): Promise<void> {
  await withUser(tgId, async (client) => {
    const { rowCount } = await client.query(
      'update pulse.content_items set idea_state = $2, updated_at = now() where id = $1',
      [contentId, state],
    );
    assertTouched(rowCount);
  });
}

export async function getPack(tgId: number | string, contentId: string): Promise<ContentPack> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<IdeaRow>(
      `select id, project_id, title, source_text, objective, audience,
              status, idea_state, created_at
         from pulse.content_items where id = $1`,
      [contentId],
    );
    if (!rows[0]) throw new DomainError('CONTENT_NOT_FOUND', 404);

    const { rows: variants } = await client.query<VariantRow>(
      `select id, content_item_id, platform, kind, body, first_hook, cta,
              metadata_json, version, status, approved_hash
         from pulse.platform_variants where content_item_id = $1 order by platform`,
      [contentId],
    );

    return {
      item: { ...toIdea(rows[0]), variantCount: variants.length },
      variants: variants.map(toVariant),
    };
  });
}

/**
 * Генерация платформенных версий.
 *
 * Уже существующие версии не затираются молча: если для площадки версия
 * есть, она остаётся — человек мог её править. Перегенерация делается
 * явно, флагом replace, и прошлый текст уходит в историю, а не в никуда.
 *
 * Пока идёт генерация, материал помечен: второе нажатие не создаст
 * второй пакет, и глаз на «Сегодня» показывает работу из этой отметки,
 * а не по таймеру.
 */
export async function generateForIdea(
  tgId: number | string,
  contentId: string,
  platforms: Platform[],
  options?: { replace?: boolean },
): Promise<ContentPack & { producedBy: string; hypothesis: string }> {
  if (!platforms.length) throw new DomainError('PLATFORMS_REQUIRED');

  const context = await withUser(tgId, async (client) => {
    const { rows } = await client.query<IdeaRow>(
      `select c.id, c.project_id, c.title, c.source_text, c.objective, c.audience,
              c.status, c.idea_state, c.created_at
         from pulse.content_items c
        where c.id = $1`,
      [contentId],
    );
    if (!rows[0]) throw new DomainError('CONTENT_NOT_FOUND', 404);

    const brand = await readBrand(client, rows[0].project_id);
    const recentHooks = await readRecentHooks(client, rows[0].project_id, contentId);
    const { rows: existing } = await client.query<{ platform: Platform; status: string }>(
      'select platform, status from pulse.platform_variants where content_item_id = $1',
      [contentId],
    );
    return {
      idea: toIdea(rows[0]),
      brand,
      recentHooks,
      existing: new Map(existing.map((e) => [e.platform, e.status])),
    };
  });

  const wanted = options?.replace
    ? platforms
    : platforms.filter((p) => !context.existing.has(p));

  // одобренное и ушедшее в очередь перегенерацией не трогаем: там уже
  // висит решение человека
  const locked = wanted.filter((p) => {
    const status = context.existing.get(p);
    return status !== undefined && !isRegeneratable(status as Variant['status']);
  });
  if (locked.length) {
    throw new DomainError(
      'VARIANT_LOCKED',
      409,
      `Уже одобрено или в очереди: ${locked.join(', ')}`,
    );
  }

  if (!wanted.length) {
    const pack = await getPack(tgId, contentId);
    return { ...pack, producedBy: 'existing', hypothesis: '' };
  }

  await claimGeneration(tgId, contentId);

  let generated: GeneratedPack;
  try {
    generated = await generatePack({
      sourceText: context.idea.sourceText,
      objective: context.idea.objective,
      audience: context.idea.audience,
      platforms: wanted,
      brand: context.brand,
      recentHooks: context.recentHooks,
    });

    await withUser(tgId, async (client) => {
      for (const draft of generated.variants) {
        const spec = PLATFORM_SPECS[draft.platform];

        // прошлый текст — в историю: перегенерация не стирает работу бесследно
        await client.query(
          `insert into pulse.variant_revisions
             (variant_id, version, body, first_hook, cta, author_id, reason)
           select id, version, body, first_hook, cta, pulse.me(), 'regenerate'
             from pulse.platform_variants
            where content_item_id = $1 and platform = $2 and kind = $3
           on conflict (variant_id, version) do nothing`,
          [contentId, draft.platform, spec.kind],
        );

        await client.query(
          `insert into pulse.platform_variants as v
             (content_item_id, platform, kind, body, first_hook, cta, metadata_json, status)
           values ($1, $2, $3, $4, $5, $6, $7, 'DRAFT')
           on conflict (content_item_id, platform, kind) do update
             set body = excluded.body,
                 first_hook = excluded.first_hook,
                 cta = excluded.cta,
                 metadata_json = excluded.metadata_json,
                 status = 'DRAFT',
                 version = v.version + 1,
                 approved_hash = null,
                 updated_at = now()`,
          [
            contentId,
            draft.platform,
            spec.kind,
            draft.body,
            draft.firstHook,
            draft.cta,
            JSON.stringify({
              hashtags: draft.hashtags,
              notes: draft.notes,
              producedBy: generated.producedBy,
            }),
          ],
        );
      }

      // ждущие решения карточки больше не про этот текст
      await client.query(
        `update pulse.approvals
            set decision = 'stale', decided_at = now()
          where decision = 'pending' and target_type = 'variant'
            and target_id in (select id from pulse.platform_variants
                               where content_item_id = $1)`,
        [contentId],
      );

      await client.query(
        `update pulse.content_items
            set status = case when status in ('IDEA', 'DRAFT') then 'DRAFT' else status end,
                idea_state = 'in_progress',
                title = case when title = '' then $2 else title end,
                updated_at = now()
          where id = $1`,
        [contentId, generated.title],
      );
    });
  } finally {
    // отметку снимаем при любом исходе: упавшая генерация не должна
    // запирать материал на пять минут
    await releaseGeneration(contentId);
  }

  await withAdmin(async (client) => {
    const ctx = await actorContext(client, tgId, context.idea.projectId);
    if (ctx) {
      await track(client, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: 'content_generated',
        props: { platforms: wanted, producedBy: generated.producedBy },
      });
    }
  });

  const pack = await getPack(tgId, contentId);
  return { ...pack, producedBy: generated.producedBy, hypothesis: generated.hypothesis };
}

/** Зависшая отметка о генерации не должна запирать материал навсегда. */
const GENERATION_LOCK_MS = 5 * 60_000;

async function claimGeneration(tgId: number | string, contentId: string): Promise<void> {
  const taken = await withUser(tgId, async (client) => {
    const { rowCount } = await client.query(
      `update pulse.content_items
          set generating_since = now()
        where id = $1
          and (generating_since is null
               or generating_since < now() - ($2 || ' milliseconds')::interval)`,
      [contentId, String(GENERATION_LOCK_MS)],
    );
    return rowCount ?? 0;
  });
  if (!taken) throw new DomainError('ALREADY_GENERATING', 409);
}

async function releaseGeneration(contentId: string): Promise<void> {
  // привилегированным путём: отметку нужно снять даже если у человека
  // отобрали права, пока модель думала
  await withAdmin(async (client) => {
    await client.query(
      'update pulse.content_items set generating_since = null where id = $1',
      [contentId],
    );
  });
}

/**
 * Ручная правка версии.
 *
 * Любая правка после одобрения сбрасывает статус в черновик — правило 3
 * из ТЗ. Прошлая версия уходит в историю, а не исчезает.
 */
export async function updateVariant(
  tgId: number | string,
  variantId: string,
  patch: { body?: string; firstHook?: string; cta?: string },
): Promise<{ variant: Variant; findings: QualityFinding[] }> {
  const result = await withUser(tgId, async (client) => {
    const { rows } = await client.query<VariantRow & { project_id: string }>(
      `select v.id, v.content_item_id, v.platform, v.kind, v.body, v.first_hook, v.cta,
              v.metadata_json, v.version, v.status, v.approved_hash, c.project_id
         from pulse.platform_variants v
         join pulse.content_items c on c.id = v.content_item_id
        where v.id = $1`,
      [variantId],
    );
    const current = rows[0];
    if (!current) throw new DomainError('VARIANT_NOT_FOUND', 404);

    // опубликованное правкой не переписывают: в канале уже висит текст,
    // и расхождение записи с реальностью хуже, чем запрет
    if (!isEditable(current.status)) {
      throw new DomainError('VARIANT_NOT_EDITABLE', 409);
    }

    const next = {
      body: patch.body ?? current.body,
      firstHook: patch.firstHook ?? current.first_hook,
      cta: patch.cta ?? current.cta,
    };

    const changed =
      next.body !== current.body ||
      next.firstHook !== current.first_hook ||
      next.cta !== current.cta;

    if (!changed) {
      const brand = await readBrand(client, current.project_id);
      return {
        variant: toVariant(current),
        findings: checkQuality({ platform: current.platform, ...next, brand }),
        projectId: current.project_id,
        changed: false,
      };
    }

    // прошлая версия в историю: сравнение «до и после» на экране согласований
    await client.query(
      `insert into pulse.variant_revisions
         (variant_id, version, body, first_hook, cta, author_id, reason)
       values ($1, $2, $3, $4, $5, pulse.me(), 'manual')
       on conflict (variant_id, version) do nothing`,
      [variantId, current.version, current.body, current.first_hook, current.cta],
    );

    const status = statusAfterEdit(current.status);
    const { rows: updated } = await client.query<VariantRow>(
      `update pulse.platform_variants
          set body = $2, first_hook = $3, cta = $4,
              version = version + 1, status = $5,
              approved_hash = null, updated_at = now()
        where id = $1
        returning id, content_item_id, platform, kind, body, first_hook, cta,
                  metadata_json, version, status, approved_hash`,
      [variantId, next.body, next.firstHook, next.cta, status],
    );
    assertTouched(updated.length);

    // ждущее решения согласование больше не про этот текст
    await client.query(
      `update pulse.approvals
          set decision = 'stale', decided_at = now()
        where target_type = 'variant' and target_id = $1 and decision = 'pending'`,
      [variantId],
    );

    // и из очереди тоже: иначе worker дойдёт до задачи, увидит расхождение
    // с одобренным снимком и отчитается провалом там, где человек просто
    // поправил текст. Задачи уходят вместе со строкой по внешнему ключу.
    await client.query(
      `delete from pulse.schedules where variant_id = $1 and status = 'SCHEDULED'`,
      [variantId],
    );

    const brand = await readBrand(client, current.project_id);
    return {
      variant: toVariant(updated[0]),
      findings: checkQuality({ platform: current.platform, ...next, brand }),
      projectId: current.project_id,
      changed: true,
    };
  });

  if (result.changed) {
    await withAdmin(async (client) => {
      const ctx = await actorContext(client, tgId, result.projectId);
      if (ctx) {
        await track(client, {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          name: 'variant_edited',
        });
      }
    });
  }

  return { variant: result.variant, findings: result.findings };
}

/** Кнопки редактора: «Усилить хук», «Сжать», «Убрать ИИ-тон» и остальные. */
export async function applyRewrite(
  tgId: number | string,
  variantId: string,
  action: RewriteAction,
): Promise<{ variant: Variant; findings: QualityFinding[]; producedBy: string }> {
  const current = await withUser(tgId, async (client) => {
    const { rows } = await client.query<VariantRow & { project_id: string }>(
      `select v.id, v.content_item_id, v.platform, v.kind, v.body, v.first_hook, v.cta,
              v.metadata_json, v.version, v.status, v.approved_hash, c.project_id
         from pulse.platform_variants v
         join pulse.content_items c on c.id = v.content_item_id
        where v.id = $1`,
      [variantId],
    );
    if (!rows[0]) throw new DomainError('VARIANT_NOT_FOUND', 404);
    const brand = await readBrand(client, rows[0].project_id);
    return { row: rows[0], brand };
  });

  const rewritten = await rewriteVariant({
    action,
    platform: current.row.platform,
    brand: current.brand,
    firstHook: current.row.first_hook,
    body: current.row.body,
    cta: current.row.cta,
  });

  // правка от модели проходит тот же путь, что и ручная: с историей и сбросом
  const { variant, findings } = await updateVariant(tgId, variantId, {
    firstHook: rewritten.firstHook,
    body: rewritten.body,
    cta: rewritten.cta,
  });

  return { variant, findings, producedBy: rewritten.producedBy };
}

/**
 * Проверка качества версии на уже открытом соединении.
 *
 * Отдельная функция, а не удобная обёртка: вызывать `withUser` изнутри
 * другой транзакции нельзя — соединение уже занято, и при пуле в пять
 * штук параллельные запросы встанут насмерть, ожидая шестое.
 */
export async function qualityOf(
  client: PoolClient,
  variantId: string,
): Promise<QualityFinding[]> {
  const { rows } = await client.query<VariantRow & { project_id: string }>(
    `select v.id, v.content_item_id, v.platform, v.kind, v.body, v.first_hook, v.cta,
            v.metadata_json, v.version, v.status, v.approved_hash, c.project_id
       from pulse.platform_variants v
       join pulse.content_items c on c.id = v.content_item_id
      where v.id = $1`,
    [variantId],
  );
  if (!rows[0]) throw new DomainError('VARIANT_NOT_FOUND', 404);

  const brand = await readBrand(client, rows[0].project_id);
  const recentHooks = await readRecentHooks(client, rows[0].project_id, rows[0].content_item_id);
  return checkQuality({
    platform: rows[0].platform,
    firstHook: rows[0].first_hook,
    body: rows[0].body,
    cta: rows[0].cta,
    brand,
    recentHooks,
  });
}

/** Проверка качества текущего текста без сохранения. */
export async function inspectVariant(
  tgId: number | string,
  variantId: string,
): Promise<QualityFinding[]> {
  return withUser(tgId, (client) => qualityOf(client, variantId));
}

export function hashOf(variant: Pick<Variant, 'body' | 'firstHook' | 'cta'>): string {
  return contentHash({ body: variant.body, firstHook: variant.firstHook, cta: variant.cta });
}

// ─────────────────────────────────────────────────────────────

async function readBrand(client: PoolClient, projectId: string): Promise<BrandProfile | null> {
  const { rows } = await client.query(
    `select project_id, positioning, audiences_json, voice_json,
            prohibited_phrases_json, examples_json, facts_json, default_cta
       from pulse.brand_profiles where project_id = $1`,
    [projectId],
  );
  return rows[0] ? toBrand(rows[0] as never) : null;
}

/** Первые строки недавних материалов проекта — чтобы не повторяться. */
async function readRecentHooks(
  client: PoolClient,
  projectId: string,
  exceptContentId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ first_hook: string }>(
    `select v.first_hook
       from pulse.platform_variants v
       join pulse.content_items c on c.id = v.content_item_id
      where c.project_id = $1 and c.id <> $2 and v.first_hook <> ''
      order by v.updated_at desc
      limit 12`,
    [projectId, exceptContentId],
  );
  return rows.map((r) => r.first_hook);
}

/** Кто и в каком пространстве действует — нужно журналу и событиям. */
export async function actorContext(
  client: PoolClient,
  tgId: number | string,
  projectId: string,
): Promise<{ userId: string; workspaceId: string } | null> {
  const { rows } = await client.query<{ user_id: string; workspace_id: string }>(
    `select u.id as user_id, p.workspace_id
       from pulse.users u, pulse.projects p
      where u.tg_id = $1 and p.id = $2`,
    [String(tgId), projectId],
  );
  return rows[0] ? { userId: rows[0].user_id, workspaceId: rows[0].workspace_id } : null;
}

export { logAction };

function autoTitle(text: string): string {
  return text.trim().split(/\s+/).slice(0, 8).join(' ').slice(0, 60);
}
