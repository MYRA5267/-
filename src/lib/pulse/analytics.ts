import { DomainError, assertTouched, withAdmin, withUser } from './db';
import { actorContext } from './content';
import { track } from './audit';
import { analyze, narrate, type AnalyticsDigest } from './ai/copilot';
import type { MetricInput, Platform, PublicationRow } from './types';

/**
 * Аналитическая петля.
 *
 * Часть метрик площадки отдают, часть — нет. Мы не изображаем полноту:
 * недоступное вводится руками, и на экране видно, откуда взялась цифра.
 */

export type Horizon = 'h24' | 'h72' | 'd7' | 'manual';

/** Какой срез уместен для публикации такого возраста. */
export function horizonFor(publishedAt: string, now = new Date()): Horizon {
  const hours = (now.getTime() - new Date(publishedAt).getTime()) / 3_600_000;
  if (hours >= 24 * 7) return 'd7';
  if (hours >= 72) return 'h72';
  if (hours >= 24) return 'h24';
  return 'manual';
}

type PublicationDbRow = {
  id: string;
  schedule_id: string;
  platform: Platform;
  title: string;
  external_url: string | null;
  published_at: string;
  metrics: MetricInput | null;
};

export async function listPublications(
  tgId: number | string,
  projectId: string,
  limit = 50,
): Promise<PublicationRow[]> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<PublicationDbRow>(
      `select p.id, p.schedule_id, p.platform, c.title, p.external_url, p.published_at,
              (select jsonb_build_object(
                        'views', m.views, 'reach', m.reach, 'likes', m.likes,
                        'replies', m.replies, 'reposts', m.reposts, 'saves', m.saves,
                        'profileVisits', m.profile_visits, 'linkClicks', m.link_clicks,
                        'watchTime', m.watch_time, 'completionRate', m.completion_rate)
                 from pulse.metric_snapshots m
                where m.publication_id = p.id
                order by m.captured_at desc limit 1) as metrics
         from pulse.publications p
         join pulse.schedules s on s.id = p.schedule_id
         join pulse.platform_variants v on v.id = s.variant_id
         join pulse.content_items c on c.id = v.content_item_id
        where p.project_id = $1
        order by p.published_at desc
        limit $2`,
      [projectId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.schedule_id,
      platform: r.platform,
      title: r.title,
      externalUrl: r.external_url,
      publishedAt: r.published_at,
      metrics: r.metrics && Object.values(r.metrics).some((v) => v !== null) ? r.metrics : null,
    }));
  });
}

/** Ручной ввод метрик. Источник помечается, чтобы не путать с API. */
export async function saveMetrics(
  tgId: number | string,
  publicationId: string,
  metrics: MetricInput,
  horizon?: Horizon,
): Promise<void> {
  const clean = sanitize(metrics);
  if (!Object.keys(clean).length) throw new DomainError('NO_METRICS');

  const projectId = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{ project_id: string; published_at: string }>(
      'select project_id, published_at from pulse.publications where id = $1',
      [publicationId],
    );
    if (!rows[0]) throw new DomainError('PUBLICATION_NOT_FOUND', 404);

    const slot = horizon ?? horizonFor(rows[0].published_at);
    const { rowCount } = await client.query(
      `insert into pulse.metric_snapshots
         (publication_id, horizon, source, views, reach, likes, replies, reposts, saves,
          profile_visits, link_clicks, watch_time, completion_rate)
       values ($1, $2, 'manual', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (publication_id, horizon, source) do update set
         captured_at = now(),
         views = coalesce(excluded.views, pulse.metric_snapshots.views),
         reach = coalesce(excluded.reach, pulse.metric_snapshots.reach),
         likes = coalesce(excluded.likes, pulse.metric_snapshots.likes),
         replies = coalesce(excluded.replies, pulse.metric_snapshots.replies),
         reposts = coalesce(excluded.reposts, pulse.metric_snapshots.reposts),
         saves = coalesce(excluded.saves, pulse.metric_snapshots.saves),
         profile_visits = coalesce(excluded.profile_visits, pulse.metric_snapshots.profile_visits),
         link_clicks = coalesce(excluded.link_clicks, pulse.metric_snapshots.link_clicks),
         watch_time = coalesce(excluded.watch_time, pulse.metric_snapshots.watch_time),
         completion_rate = coalesce(excluded.completion_rate, pulse.metric_snapshots.completion_rate)`,
      [
        publicationId,
        slot,
        clean.views ?? null,
        clean.reach ?? null,
        clean.likes ?? null,
        clean.replies ?? null,
        clean.reposts ?? null,
        clean.saves ?? null,
        clean.profileVisits ?? null,
        clean.linkClicks ?? null,
        clean.watchTime ?? null,
        clean.completionRate ?? null,
      ],
    );
    assertTouched(rowCount);

    // материал ушёл из производства в измерение
    await client.query(
      `update pulse.content_items
          set status = case when status = 'PUBLISHED' then 'MEASURING' else status end,
              updated_at = now()
        where id = (select v.content_item_id
                      from pulse.publications p
                      join pulse.schedules s on s.id = p.schedule_id
                      join pulse.platform_variants v on v.id = s.variant_id
                     where p.id = $1)`,
      [publicationId],
    );

    return rows[0].project_id;
  });

  await withAdmin(async (client) => {
    const ctx = await actorContext(client, tgId, projectId);
    if (ctx) {
      await track(client, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: 'metrics_imported',
        props: { source: 'manual' },
      });
    }
  });
}

/** Разбор проекта: что повторить, что изменить и что больше не делать. */
export async function digest(
  tgId: number | string,
  projectId: string,
  options?: { explain?: boolean },
): Promise<AnalyticsDigest & { projectName: string }> {
  const { publications, projectName } = await withUser(tgId, async (client) => {
    const { rows: project } = await client.query<{ name: string }>(
      'select name from pulse.projects where id = $1',
      [projectId],
    );
    if (!project[0]) throw new DomainError('PROJECT_NOT_FOUND', 404);
    return { publications: await listForDigest(client, projectId), projectName: project[0].name };
  });

  const base = analyze(publications);
  const result = options?.explain ? await narrate(base, projectName) : base;
  return { ...result, projectName };
}

async function listForDigest(client: import('pg').PoolClient, projectId: string) {
  const { rows } = await client.query<PublicationDbRow>(
    `select p.id, p.schedule_id, p.platform, c.title, p.external_url, p.published_at,
            (select jsonb_build_object(
                      'views', m.views, 'reach', m.reach, 'likes', m.likes,
                      'replies', m.replies, 'reposts', m.reposts, 'saves', m.saves,
                      'profileVisits', m.profile_visits, 'linkClicks', m.link_clicks,
                      'watchTime', m.watch_time, 'completionRate', m.completion_rate)
               from pulse.metric_snapshots m
              where m.publication_id = p.id
              order by m.captured_at desc limit 1) as metrics
       from pulse.publications p
       join pulse.schedules s on s.id = p.schedule_id
       join pulse.platform_variants v on v.id = s.variant_id
       join pulse.content_items c on c.id = v.content_item_id
      where p.project_id = $1
      order by p.published_at desc
      limit 100`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    platform: r.platform,
    publishedAt: r.published_at,
    metrics: r.metrics,
  }));
}

/** Гипотеза из разбора возвращается в банк идей — петля замыкается. */
export async function acceptHypothesis(
  tgId: number | string,
  projectId: string,
  text: string,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new DomainError('TEXT_REQUIRED');

  const id = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into pulse.content_items
         (project_id, title, source_text, author_id, status, idea_state)
       values ($1, $2, $3, pulse.me(), 'IDEA', 'new')
       returning id`,
      [projectId, trimmed.slice(0, 60), trimmed],
    );
    if (!rows[0]) throw new DomainError('FORBIDDEN', 403);
    return rows[0].id;
  });

  await withAdmin(async (client) => {
    const ctx = await actorContext(client, tgId, projectId);
    if (ctx) {
      await track(client, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        name: 'hypothesis_accepted',
      });
    }
  });

  return id;
}

function sanitize(m: MetricInput): MetricInput {
  const out: MetricInput = {};
  for (const [key, value] of Object.entries(m)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    (out as Record<string, number>)[key] = value;
  }
  return out;
}
