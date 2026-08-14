/** Общие типы PULSE. Ровно то, что пересекает границу сервер ↔ экран. */

export const PLATFORMS = ['telegram', 'threads', 'instagram', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Полностью автоматическая публикация есть только там, где выдан доступ. */
export const AUTO_PUBLISH: Record<Platform, boolean> = {
  telegram: true,
  threads: false,
  instagram: false,
  tiktok: false,
};

export const ROLES = ['owner', 'admin', 'editor', 'approver', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Тот же порядок, что и в pulse.roles — база остаётся источником истины. */
export const ROLE_RANK: Record<Role, number> = {
  owner: 60,
  admin: 50,
  editor: 40,
  approver: 30,
  analyst: 20,
  viewer: 10,
};

export type Objective = 'reach' | 'trust' | 'click' | 'lead' | 'sale';

export const OBJECTIVE_LABEL: Record<Objective, string> = {
  reach: 'охват',
  trust: 'доверие',
  click: 'переход',
  lead: 'заявка',
  sale: 'продажа',
};

/** Жизненный путь материала. Порядок значим: см. canTransition. */
export const CONTENT_STATUSES = [
  'IDEA',
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'MEASURING',
  'ANALYZED',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const ERROR_STATUSES = [
  'AUTH_REQUIRED',
  'MEDIA_INVALID',
  'PLATFORM_REJECTED',
  'RATE_LIMITED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
] as const;
export type ErrorStatus = (typeof ERROR_STATUSES)[number];

export type VariantStatus = ContentStatus | ErrorStatus;

export type IdeaState = 'new' | 'in_progress' | 'used' | 'research' | 'later';

export type VariantKind = 'post' | 'thread' | 'caption' | 'script' | 'carousel' | 'story';

export type Me = {
  id: string;
  tgId: string;
  name: string;
  timezone: string;
};

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'product' | 'client' | 'agency';
  plan: string;
  role: Role;
  projectCount: number;
};

export type Project = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  timezone: string;
  accent: string;
  status: 'active' | 'paused' | 'archived';
};

export type BrandProfile = {
  projectId: string;
  positioning: string;
  audiences: string[];
  voice: {
    tone?: string;
    humor?: string;
    emoji?: 'none' | 'rare' | 'often';
    length?: 'short' | 'medium' | 'long';
  };
  prohibitedPhrases: string[];
  examples: { good: string[]; bad: string[] };
  facts: Array<{ claim: string; source?: string }>;
  defaultCta: string;
};

export type Idea = {
  id: string;
  projectId: string;
  title: string;
  sourceText: string;
  objective: Objective;
  audience: string;
  status: ContentStatus;
  ideaState: IdeaState;
  createdAt: string;
  variantCount: number;
};

export type Variant = {
  id: string;
  contentItemId: string;
  platform: Platform;
  kind: VariantKind;
  body: string;
  firstHook: string;
  cta: string;
  metadata: Record<string, unknown>;
  version: number;
  status: VariantStatus;
  /** Совпадает с текущим текстом только пока после одобрения ничего не правили. */
  approvedHash: string | null;
};

export type ContentPack = {
  item: Idea;
  variants: Variant[];
};

export type Approval = {
  id: string;
  projectId: string;
  targetType: 'variant' | 'content_item';
  targetId: string;
  decision: 'pending' | 'approved' | 'rejected' | 'stale';
  comment: string;
  createdAt: string;
  decidedAt: string | null;
  /** Заполняется на экране согласований, чтобы не ходить за текстом отдельно. */
  preview?: { platform: Platform; firstHook: string; body: string };
};

export type Schedule = {
  id: string;
  projectId: string;
  variantId: string;
  platform: Platform;
  scheduledAt: string;
  timezone: string;
  status: VariantStatus;
  title: string;
  accent: string;
  externalUrl?: string | null;
  errorMessage?: string | null;
};

export type SocialAccount = {
  id: string;
  projectId: string;
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  status: 'connected' | 'auth_required' | 'export_only' | 'disabled';
  tokenExpiresAt: string | null;
  lastSyncedAt: string | null;
};

export type MetricInput = {
  views?: number;
  reach?: number;
  likes?: number;
  replies?: number;
  reposts?: number;
  saves?: number;
  profileVisits?: number;
  linkClicks?: number;
  watchTime?: number;
  completionRate?: number;
};

export type PublicationRow = {
  id: string;
  scheduleId: string;
  platform: Platform;
  title: string;
  externalUrl: string | null;
  publishedAt: string;
  metrics: MetricInput | null;
};

/** Экран «Сегодня»: одно главное действие и короткий контекст вокруг него. */
export type TodayFocus =
  | { kind: 'connect'; label: string; href: string }
  | { kind: 'idea'; label: string; href: string }
  | { kind: 'generate'; label: string; href: string; contentId: string }
  | { kind: 'approve'; label: string; href: string; count: number }
  | { kind: 'schedule'; label: string; href: string; count: number }
  | { kind: 'fix'; label: string; href: string; count: number }
  | { kind: 'measure'; label: string; href: string; count: number }
  | { kind: 'calm'; label: string; href: string };

export type Today = {
  focus: TodayFocus;
  /** Состояние глаза берётся из очереди, а не проигрывается случайно. */
  eye: EyeState;
  nextPublication: Schedule | null;
  pendingApprovals: number;
  failedJobs: number;
  yesterday: { published: number; views: number | null };
};

export type EyeState =
  | 'breathing'  // всё обработано
  | 'focusing'   // идёт генерация
  | 'watching'   // ждём решения человека
  | 'ringed'     // публикация запланирована
  | 'flash'      // публикация отправлена
  | 'torn'       // ошибка подключения
  | 'closed';    // срочных задач нет

export type ApiError = { error: string; detail?: string };
