import { withUser } from './db';
import type { EyeState, Schedule, Today, TodayFocus } from './types';

/**
 * Экран «Сегодня».
 *
 * Одно главное действие, а не кладбище графиков. Порядок приоритетов
 * жёсткий: сначала то, что сломано, потом то, что ждёт человека,
 * потом то, что двигает работу вперёд.
 */

type Counts = {
  accounts: number;
  ideasWithoutVariants: number;
  ideasTotal: number;
  pendingApprovals: number;
  approvedNotScheduled: number;
  failedJobs: number;
  publishedWithoutMetrics: number;
  generating: number;
  publishedYesterday: number;
  viewsYesterday: number | null;
  next: Schedule | null;
};

export async function todayFor(
  tgId: number | string,
  scope: { workspaceId?: string; projectId?: string },
): Promise<Today> {
  const counts = await load(tgId, scope);
  const focus = pickFocus(counts, scope);

  return {
    focus,
    eye: pickEye(counts, focus),
    nextPublication: counts.next,
    pendingApprovals: counts.pendingApprovals,
    failedJobs: counts.failedJobs,
    yesterday: { published: counts.publishedYesterday, views: counts.viewsYesterday },
  };
}

async function load(
  tgId: number | string,
  scope: { workspaceId?: string; projectId?: string },
): Promise<Counts> {
  return withUser(tgId, async (client) => {
    const p = scope.projectId ?? null;
    const w = scope.workspaceId ?? null;
    // проекты в области видимости — дальше всё считается по ним
    const scoped = `
      select id from pulse.projects
       where status <> 'archived'
         and ($1::uuid is null or id = $1)
         and ($2::uuid is null or workspace_id = $2)`;

    const { rows } = await client.query<Record<string, string | null>>(
      `with scoped as (${scoped})
       select
         (select count(*) from pulse.social_accounts
           where project_id in (select id from scoped) and status = 'connected') as accounts,
         (select count(*) from pulse.content_items c
           where c.project_id in (select id from scoped)
             and c.status = 'IDEA'
             and not exists (select 1 from pulse.platform_variants v
                              where v.content_item_id = c.id)) as ideas_without_variants,
         (select count(*) from pulse.content_items
           where project_id in (select id from scoped)) as ideas_total,
         (select count(*) from pulse.content_items
           where project_id in (select id from scoped)
             and generating_since is not null
             and generating_since > now() - interval '5 minutes') as generating,
         (select count(*) from pulse.approvals
           where project_id in (select id from scoped) and decision = 'pending')
             as pending_approvals,
         (select count(*) from pulse.platform_variants v
            join pulse.content_items c on c.id = v.content_item_id
           where c.project_id in (select id from scoped)
             and v.status = 'APPROVED'
             and not exists (select 1 from pulse.schedules s
                              where s.variant_id = v.id
                                and s.status in ('SCHEDULED', 'PUBLISHING', 'PUBLISHED')))
             as approved_not_scheduled,
         (select count(*) from pulse.schedules s
           where s.project_id in (select id from scoped)
             and s.status in ('AUTH_REQUIRED', 'MEDIA_INVALID', 'PLATFORM_REJECTED',
                              'RATE_LIMITED', 'FAILED_FINAL')) as failed_jobs,
         (select count(*) from pulse.publications pub
           where pub.project_id in (select id from scoped)
             and pub.published_at < now() - interval '24 hours'
             and not exists (select 1 from pulse.metric_snapshots m
                              where m.publication_id = pub.id)) as published_without_metrics,
         (select count(*) from pulse.publications pub
           where pub.project_id in (select id from scoped)
             and pub.published_at >= date_trunc('day', now()) - interval '1 day'
             and pub.published_at < date_trunc('day', now())) as published_yesterday,
         (select sum(m.views) from pulse.metric_snapshots m
            join pulse.publications pub on pub.id = m.publication_id
           where pub.project_id in (select id from scoped)
             and pub.published_at >= date_trunc('day', now()) - interval '1 day'
             and pub.published_at < date_trunc('day', now())) as views_yesterday`,
      [p, w],
    );

    const row = rows[0] ?? {};
    const { rows: next } = await client.query<{
      id: string;
      project_id: string;
      variant_id: string;
      platform: string;
      scheduled_at: string;
      timezone: string;
      status: string;
      title: string;
      accent: string;
    }>(
      `with scoped as (${scoped})
       select s.id, s.project_id, s.variant_id, v.platform, s.scheduled_at, s.timezone,
              s.status, c.title, pr.accent
         from pulse.schedules s
         join pulse.platform_variants v on v.id = s.variant_id
         join pulse.content_items c on c.id = v.content_item_id
         join pulse.projects pr on pr.id = s.project_id
        where s.project_id in (select id from scoped)
          and s.status in ('SCHEDULED', 'PUBLISHING')
        order by s.scheduled_at
        limit 1`,
      [p, w],
    );

    return {
      accounts: num(row.accounts),
      ideasWithoutVariants: num(row.ideas_without_variants),
      ideasTotal: num(row.ideas_total),
      pendingApprovals: num(row.pending_approvals),
      approvedNotScheduled: num(row.approved_not_scheduled),
      failedJobs: num(row.failed_jobs),
      publishedWithoutMetrics: num(row.published_without_metrics),
      generating: num(row.generating),
      publishedYesterday: num(row.published_yesterday),
      viewsYesterday: row.views_yesterday === null ? null : num(row.views_yesterday),
      next: next[0]
        ? {
            id: next[0].id,
            projectId: next[0].project_id,
            variantId: next[0].variant_id,
            platform: next[0].platform as Schedule['platform'],
            scheduledAt: next[0].scheduled_at,
            timezone: next[0].timezone,
            status: next[0].status as Schedule['status'],
            title: next[0].title,
            accent: next[0].accent,
          }
        : null,
    };
  });
}

/** Одно действие. Порядок здесь и есть продукт. */
function pickFocus(counts: Counts, scope: { projectId?: string }): TodayFocus {
  const q = scope.projectId ? `?project=${scope.projectId}` : '';

  if (counts.failedJobs > 0) {
    return {
      kind: 'fix',
      label: `Разобрать ошибки очереди (${counts.failedJobs})`,
      href: `/pulse/calendar${q}`,
      count: counts.failedJobs,
    };
  }
  if (counts.pendingApprovals > 0) {
    return {
      kind: 'approve',
      label: `Решить по материалам (${counts.pendingApprovals})`,
      href: `/pulse/approvals${q}`,
      count: counts.pendingApprovals,
    };
  }
  if (counts.accounts === 0) {
    return { kind: 'connect', label: 'Подключить первый канал', href: `/pulse/connections${q}` };
  }
  if (counts.approvedNotScheduled > 0) {
    return {
      kind: 'schedule',
      label: `Поставить в календарь (${counts.approvedNotScheduled})`,
      href: `/pulse/calendar${q}`,
      count: counts.approvedNotScheduled,
    };
  }
  if (counts.ideasWithoutVariants > 0) {
    return {
      kind: 'generate',
      label: 'Собрать пакет из идеи',
      href: `/pulse/ideas${q}`,
      contentId: '',
    };
  }
  if (counts.publishedWithoutMetrics > 0) {
    return {
      kind: 'measure',
      label: `Внести результаты (${counts.publishedWithoutMetrics})`,
      href: `/pulse/analytics${q}`,
      count: counts.publishedWithoutMetrics,
    };
  }
  if (counts.ideasTotal === 0) {
    return { kind: 'idea', label: 'Добавить первую идею', href: `/pulse/ideas${q}` };
  }
  return { kind: 'calm', label: 'Всё обработано. Можно добавить идею', href: `/pulse/ideas${q}` };
}

/**
 * Глаз показывает состояние системы, а не настроение дизайнера.
 * Значение берётся из очереди — иначе это просто анимация.
 */
function pickEye(counts: Counts, focus: TodayFocus): EyeState {
  if (counts.failedJobs > 0) return 'torn';
  if (counts.generating > 0) return 'focusing';
  if (counts.pendingApprovals > 0) return 'watching';
  if (counts.next) return 'ringed';
  if (focus.kind === 'calm') return 'closed';
  return 'breathing';
}

function num(value: string | null | undefined): number {
  return value ? Number(value) : 0;
}
