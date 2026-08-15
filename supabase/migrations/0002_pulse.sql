-- PULSE Studio — схема продукта.
--
-- Продукт multi-tenant: пользователь → пространство → проект → аккаунты → контент.
-- Изоляция арендаторов обеспечивается RLS, а не кодом приложения: если политика
-- пропускает, приложение это не спасёт.
--
-- Контракт с приложением ровно тот же, что и у остальной базы:
--   set local role authenticated;
--   select set_config('app.tg_id', '<tg_id>', true);
-- Всё остальное решают политики ниже.
--
-- Живёт в отдельной схеме `pulse`, чтобы не пересекаться с уже существующим
-- продуктом в `public`.

begin;

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

create schema if not exists pulse;

-- ─────────────────────────────────────────────────────────────
-- Справочники значений. Не enum: площадки и статусы добавляются
-- чаще, чем хочется писать миграцию с alter type.
-- ─────────────────────────────────────────────────────────────

-- роли по убыванию прав; сравнение идёт по этому порядку
create table if not exists pulse.roles (
  role  text primary key,
  rank  smallint not null unique
);

insert into pulse.roles (role, rank) values
  ('owner', 60), ('admin', 50), ('editor', 40),
  ('approver', 30), ('analyst', 20), ('viewer', 10)
on conflict (role) do nothing;

-- ─────────────────────────────────────────────────────────────
-- Люди и пространства
-- ─────────────────────────────────────────────────────────────

create table if not exists pulse.users (
  id         uuid primary key default gen_random_uuid(),
  tg_id      bigint not null unique,
  email      text,
  name       text not null default '',
  avatar_url text,
  locale     text not null default 'ru',
  timezone   text not null default 'Europe/Amsterdam',
  created_at timestamptz not null default now()
);

create table if not exists pulse.workspaces (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references pulse.users(id) on delete restrict,
  name       text not null,
  slug       text not null unique,
  type       text not null default 'personal'
             check (type in ('personal', 'product', 'client', 'agency')),
  plan       text not null default 'pilot',
  created_at timestamptz not null default now(),
  -- удаление сначала мягкое: у клиента должен быть период на «верните обратно»
  deleted_at timestamptz
);

create table if not exists pulse.memberships (
  workspace_id uuid not null references pulse.workspaces(id) on delete cascade,
  user_id      uuid not null references pulse.users(id) on delete cascade,
  role         text not null references pulse.roles(role),
  invited_by   uuid references pulse.users(id) on delete set null,
  status       text not null default 'active' check (status in ('active', 'invited', 'revoked')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists memberships_user_idx on pulse.memberships (user_id)
  where status = 'active';

-- приглашение по коду: человека ещё нет в пространстве, значит RLS про него
-- ничего не знает — единственный путь через привилегированную функцию
create table if not exists pulse.invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references pulse.workspaces(id) on delete cascade,
  code         text not null unique,
  role         text not null references pulse.roles(role),
  created_by   uuid not null references pulse.users(id) on delete cascade,
  expires_at   timestamptz not null default (now() + interval '14 days'),
  accepted_by  uuid references pulse.users(id) on delete set null,
  accepted_at  timestamptz
);

-- ─────────────────────────────────────────────────────────────
-- Проекты и бренд
-- ─────────────────────────────────────────────────────────────

create table if not exists pulse.projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references pulse.workspaces(id) on delete cascade,
  name         text not null,
  description  text,
  logo_url     text,
  -- время хранится в UTC, показывается в этом поясе
  timezone     text not null default 'Europe/Amsterdam',
  accent       text not null default '#FF4A1C',
  status       text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at   timestamptz not null default now()
);

create index if not exists projects_workspace_idx on pulse.projects (workspace_id)
  where status <> 'archived';

create table if not exists pulse.brand_profiles (
  project_id             uuid primary key references pulse.projects(id) on delete cascade,
  positioning            text not null default '',
  audiences_json         jsonb not null default '[]'::jsonb,
  voice_json             jsonb not null default '{}'::jsonb,
  prohibited_phrases_json jsonb not null default '[]'::jsonb,
  examples_json          jsonb not null default '{"good": [], "bad": []}'::jsonb,
  facts_json             jsonb not null default '[]'::jsonb,
  default_cta            text not null default '',
  updated_at             timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Подключения площадок.
--
-- Токены шифруются приложением (AES-256-GCM) до попадания в базу и
-- физически не выдаются роли authenticated: колонки с секретами
-- исключены из grant select ниже. Frontend их не получит даже при
-- ошибке в коде — просто нет права на колонку.
-- ─────────────────────────────────────────────────────────────

create table if not exists pulse.social_accounts (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references pulse.projects(id) on delete cascade,
  platform                text not null check (platform in ('telegram', 'threads', 'instagram', 'tiktok')),
  external_account_id     text not null,
  display_name            text not null default '',
  token_ciphertext        text,
  refresh_token_ciphertext text,
  token_expires_at        timestamptz,
  permissions_json        jsonb not null default '[]'::jsonb,
  -- connected — публикуем сами; export_only — собираем пакет, публикует человек
  status                  text not null default 'connected'
                          check (status in ('connected', 'auth_required', 'export_only', 'disabled')),
  last_synced_at          timestamptz,
  created_at              timestamptz not null default now(),
  unique (project_id, platform, external_account_id)
);

create index if not exists social_accounts_project_idx on pulse.social_accounts (project_id);

-- ─────────────────────────────────────────────────────────────
-- Контент
-- ─────────────────────────────────────────────────────────────

create table if not exists pulse.content_items (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references pulse.projects(id) on delete cascade,
  parent_id   uuid references pulse.content_items(id) on delete set null,
  type        text not null default 'idea' check (type in ('idea', 'pack', 'series')),
  title       text not null default '',
  source_text text not null default '',
  objective   text not null default 'reach'
              check (objective in ('reach', 'trust', 'click', 'lead', 'sale')),
  audience    text not null default '',
  status      text not null default 'IDEA',
  idea_state  text not null default 'new'
              check (idea_state in ('new', 'in_progress', 'used', 'research', 'later')),
  author_id   uuid references pulse.users(id) on delete set null,
  -- идёт генерация: одновременно её начать нельзя, и глаз показывает это
  -- состояние из реальной работы, а не по таймеру
  generating_since timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists content_project_idx on pulse.content_items (project_id, created_at desc);

create table if not exists pulse.platform_variants (
  id              uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references pulse.content_items(id) on delete cascade,
  platform        text not null check (platform in ('telegram', 'threads', 'instagram', 'tiktok')),
  kind            text not null default 'post'
                  check (kind in ('post', 'thread', 'caption', 'script', 'carousel', 'story')),
  body            text not null default '',
  first_hook      text not null default '',
  cta             text not null default '',
  metadata_json   jsonb not null default '{}'::jsonb,
  version         integer not null default 1,
  status          text not null default 'DRAFT',
  -- снимок одобренного текста: правка после одобрения обязана сбросить статус
  approved_hash   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists variants_content_idx on pulse.platform_variants (content_item_id);

-- одна версия на пару «площадка + формат»: перегенерация заменяет её,
-- а не кладёт рядом вторую. Формат в ключе, потому что у Instagram
-- со временем появятся и подпись, и сценарий Reels.
create unique index if not exists variants_unique_slot
  on pulse.platform_variants (content_item_id, platform, kind);

create table if not exists pulse.variant_revisions (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null references pulse.platform_variants(id) on delete cascade,
  version    integer not null,
  body       text not null,
  first_hook text not null default '',
  cta        text not null default '',
  author_id  uuid references pulse.users(id) on delete set null,
  reason     text not null default '',
  created_at timestamptz not null default now(),
  unique (variant_id, version)
);

create table if not exists pulse.assets (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references pulse.projects(id) on delete cascade,
  content_item_id uuid references pulse.content_items(id) on delete set null,
  kind            text not null check (kind in ('image', 'video', 'document', 'audio')),
  storage_url     text not null,
  mime_type       text,
  width           integer,
  height          integer,
  duration        numeric,
  metadata_json   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Согласование
-- ─────────────────────────────────────────────────────────────

create table if not exists pulse.approvals (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references pulse.projects(id) on delete cascade,
  target_type  text not null check (target_type in ('variant', 'content_item')),
  target_id    uuid not null,
  -- что именно одобряется: хэш текста на момент запроса
  target_hash  text not null,
  requested_by uuid references pulse.users(id) on delete set null,
  decided_by   uuid references pulse.users(id) on delete set null,
  decision     text not null default 'pending'
               check (decision in ('pending', 'approved', 'rejected', 'stale')),
  comment      text not null default '',
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);

create index if not exists approvals_pending_idx on pulse.approvals (project_id, created_at desc)
  where decision = 'pending';

-- по этому пути ходит каждая правка версии: найти ждущее решения согласование
create index if not exists approvals_target_idx on pulse.approvals (target_type, target_id)
  where decision = 'pending';

-- ─────────────────────────────────────────────────────────────
-- Очередь и публикации
-- ─────────────────────────────────────────────────────────────

create table if not exists pulse.schedules (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references pulse.projects(id) on delete cascade,
  variant_id        uuid not null references pulse.platform_variants(id) on delete cascade,
  social_account_id uuid references pulse.social_accounts(id) on delete set null,
  scheduled_at      timestamptz not null,
  timezone          text not null default 'Europe/Amsterdam',
  status            text not null default 'SCHEDULED',
  -- одобренный снимок, с которым публикация ушла в очередь
  approved_hash     text not null,
  created_by        uuid references pulse.users(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists schedules_due_idx on pulse.schedules (scheduled_at)
  where status = 'SCHEDULED';
create index if not exists schedules_project_idx on pulse.schedules (project_id, scheduled_at);

create table if not exists pulse.publish_jobs (
  id              uuid primary key default gen_random_uuid(),
  schedule_id     uuid not null references pulse.schedules(id) on delete cascade,
  attempt         integer not null default 0,
  -- защита от двойной отправки: сеть моргнула — пост всё равно один
  idempotency_key text not null unique,
  status          text not null default 'PENDING'
                  check (status in ('PENDING', 'RUNNING', 'DONE', 'FAILED_RETRYABLE', 'FAILED_FINAL')),
  error_code      text,
  error_message   text,
  next_retry_at   timestamptz,
  locked_at       timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists publish_jobs_ready_idx on pulse.publish_jobs (next_retry_at)
  where status in ('PENDING', 'FAILED_RETRYABLE');

create table if not exists pulse.publications (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references pulse.projects(id) on delete cascade,
  schedule_id           uuid not null unique references pulse.schedules(id) on delete cascade,
  platform              text not null,
  external_post_id      text,
  external_url          text,
  published_at          timestamptz not null default now(),
  payload_snapshot_json jsonb not null default '{}'::jsonb
);

create index if not exists publications_project_idx on pulse.publications (project_id, published_at desc);

create table if not exists pulse.metric_snapshots (
  id              uuid primary key default gen_random_uuid(),
  publication_id  uuid not null references pulse.publications(id) on delete cascade,
  captured_at     timestamptz not null default now(),
  -- какой срез: 24 часа, 72 часа, 7 дней или ручной ввод
  horizon         text not null default 'manual'
                  check (horizon in ('h24', 'h72', 'd7', 'manual')),
  source          text not null default 'manual' check (source in ('manual', 'api')),
  views           integer,
  reach           integer,
  likes           integer,
  replies         integer,
  reposts         integer,
  saves           integer,
  profile_visits  integer,
  link_clicks     integer,
  watch_time      numeric,
  completion_rate numeric,
  custom_json     jsonb not null default '{}'::jsonb,
  unique (publication_id, horizon, source)
);

-- ─────────────────────────────────────────────────────────────
-- Правила, журнал, события продукта
-- ─────────────────────────────────────────────────────────────

create table if not exists pulse.automation_rules (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references pulse.projects(id) on delete cascade,
  trigger_type    text not null,
  conditions_json jsonb not null default '{}'::jsonb,
  action_type     text not null,
  action_json     jsonb not null default '{}'::jsonb,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);

create table if not exists pulse.audit_logs (
  id           bigserial primary key,
  workspace_id uuid not null references pulse.workspaces(id) on delete cascade,
  actor_id     uuid references pulse.users(id) on delete set null,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  before_json  jsonb,
  after_json   jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists audit_workspace_idx on pulse.audit_logs (workspace_id, created_at desc);

create table if not exists pulse.events (
  id           bigserial primary key,
  workspace_id uuid references pulse.workspaces(id) on delete cascade,
  user_id      uuid references pulse.users(id) on delete set null,
  name         text not null,
  props_json   jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists events_name_idx on pulse.events (name, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Текущий человек и его роль.
--
-- security definer — иначе политика на memberships рекурсирует сама в себя:
-- чтобы прочитать memberships, нужно узнать роль, а чтобы узнать роль,
-- нужно прочитать memberships.
-- ─────────────────────────────────────────────────────────────

create or replace function pulse.current_tg_id() returns bigint
  language sql stable
as $$
  select nullif(current_setting('app.tg_id', true), '')::bigint
$$;

create or replace function pulse.me() returns uuid
  language sql stable security definer set search_path = pulse, pg_temp
as $$
  select u.id from pulse.users u where u.tg_id = pulse.current_tg_id()
$$;

-- ранг роли в пространстве; 0 — не участник
create or replace function pulse.rank_in(ws uuid) returns smallint
  language sql stable security definer set search_path = pulse, pg_temp
as $$
  select coalesce(
    (select r.rank
       from pulse.memberships m
       join pulse.roles r on r.role = m.role
      where m.workspace_id = ws
        and m.user_id = pulse.me()
        and m.status = 'active'),
    0)::smallint
$$;

-- ранг в пространстве, которому принадлежит проект
create or replace function pulse.rank_in_project(pid uuid) returns smallint
  language sql stable security definer set search_path = pulse, pg_temp
as $$
  select coalesce(
    (select pulse.rank_in(p.workspace_id) from pulse.projects p where p.id = pid),
    0)::smallint
$$;

-- Именованная роль в проекте.
--
-- Ранг годится для «читать ≤ править ≤ управлять», но не для одобрения:
-- редактор по рангу выше approver'а, и порог «ранг ≥ approver» пустил бы
-- автора одобрять собственный текст. Гарантия четырёх глаз держится
-- на конкретной роли, а не на её месте в лестнице.
create or replace function pulse.role_in_project(pid uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp
as $$
  select m.role
    from pulse.projects p
    join pulse.memberships m on m.workspace_id = p.workspace_id
   where p.id = pid and m.user_id = pulse.me() and m.status = 'active'
$$;

-- владелец пространства для проекта — нужен политикам audit/events
create or replace function pulse.workspace_of_project(pid uuid) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp
as $$
  select p.workspace_id from pulse.projects p where p.id = pid
$$;

create or replace function pulse.project_of_variant(vid uuid) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp
as $$
  select c.project_id
    from pulse.platform_variants v
    join pulse.content_items c on c.id = v.content_item_id
   where v.id = vid
$$;

-- Код приглашения: 8 символов без похожих друг на друга.
create or replace function pulse.gen_invite_code() returns text
  language plpgsql volatile set search_path = pulse, pg_temp
as $$
declare
  alphabet constant text := 'ACDEFGHJKMNPQRTUVWXY34679';
  code text;
begin
  loop
    code := '';
    for _i in 1..8 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from pulse.invitations i where i.code = code);
  end loop;
  return code;
end
$$;

alter table pulse.invitations alter column code set default pulse.gen_invite_code();

-- ─────────────────────────────────────────────────────────────
-- RLS.
--
-- Пороги рангов: 10 viewer, 20 analyst, 30 approver, 40 editor,
-- 50 admin, 60 owner. Читает любой участник, пишет от editor,
-- решает судьбу публикации approver, интеграции трогает admin.
-- ─────────────────────────────────────────────────────────────

alter table pulse.users             enable row level security;
alter table pulse.workspaces        enable row level security;
alter table pulse.memberships       enable row level security;
alter table pulse.invitations       enable row level security;
alter table pulse.projects          enable row level security;
alter table pulse.brand_profiles    enable row level security;
alter table pulse.social_accounts   enable row level security;
alter table pulse.content_items     enable row level security;
alter table pulse.platform_variants enable row level security;
alter table pulse.variant_revisions enable row level security;
alter table pulse.assets            enable row level security;
alter table pulse.approvals         enable row level security;
alter table pulse.schedules         enable row level security;
alter table pulse.publish_jobs      enable row level security;
alter table pulse.publications      enable row level security;
alter table pulse.metric_snapshots  enable row level security;
alter table pulse.automation_rules  enable row level security;
alter table pulse.audit_logs        enable row level security;
alter table pulse.events            enable row level security;
alter table pulse.roles             enable row level security;

drop policy if exists roles_read on pulse.roles;
create policy roles_read on pulse.roles for select to authenticated using (true);

-- users: себя и тех, с кем делишь пространство
drop policy if exists users_select on pulse.users;
create policy users_select on pulse.users
  for select to authenticated
  using (
    id = pulse.me()
    or exists (
      select 1
        from pulse.memberships mine
        join pulse.memberships theirs on theirs.workspace_id = mine.workspace_id
       where mine.user_id = pulse.me() and mine.status = 'active'
         and theirs.user_id = pulse.users.id and theirs.status = 'active'
    )
  );

drop policy if exists users_update_self on pulse.users;
create policy users_update_self on pulse.users
  for update to authenticated
  using (id = pulse.me()) with check (id = pulse.me());

-- workspaces
drop policy if exists workspaces_select on pulse.workspaces;
create policy workspaces_select on pulse.workspaces
  for select to authenticated
  using (pulse.rank_in(id) > 0 and deleted_at is null);

drop policy if exists workspaces_update on pulse.workspaces;
create policy workspaces_update on pulse.workspaces
  for update to authenticated
  using (pulse.rank_in(id) >= 50) with check (pulse.rank_in(id) >= 50);

drop policy if exists workspaces_delete on pulse.workspaces;
create policy workspaces_delete on pulse.workspaces
  for delete to authenticated
  using (pulse.rank_in(id) >= 60);

-- memberships
drop policy if exists memberships_select on pulse.memberships;
create policy memberships_select on pulse.memberships
  for select to authenticated
  using (pulse.rank_in(workspace_id) > 0);

drop policy if exists memberships_write on pulse.memberships;
create policy memberships_write on pulse.memberships
  for insert to authenticated
  with check (pulse.rank_in(workspace_id) >= 50);

drop policy if exists memberships_update on pulse.memberships;
create policy memberships_update on pulse.memberships
  for update to authenticated
  using (pulse.rank_in(workspace_id) >= 50)
  with check (pulse.rank_in(workspace_id) >= 50);

drop policy if exists memberships_delete on pulse.memberships;
create policy memberships_delete on pulse.memberships
  for delete to authenticated
  using (pulse.rank_in(workspace_id) >= 50 and role <> 'owner');

-- invitations: код видит только тот, кто может звать
drop policy if exists invitations_select on pulse.invitations;
create policy invitations_select on pulse.invitations
  for select to authenticated
  using (pulse.rank_in(workspace_id) >= 50);

drop policy if exists invitations_insert on pulse.invitations;
create policy invitations_insert on pulse.invitations
  for insert to authenticated
  with check (pulse.rank_in(workspace_id) >= 50 and created_by = pulse.me());

drop policy if exists invitations_delete on pulse.invitations;
create policy invitations_delete on pulse.invitations
  for delete to authenticated
  using (pulse.rank_in(workspace_id) >= 50);

-- projects
drop policy if exists projects_select on pulse.projects;
create policy projects_select on pulse.projects
  for select to authenticated
  using (pulse.rank_in(workspace_id) > 0);

drop policy if exists projects_insert on pulse.projects;
create policy projects_insert on pulse.projects
  for insert to authenticated
  with check (pulse.rank_in(workspace_id) >= 50);

drop policy if exists projects_update on pulse.projects;
create policy projects_update on pulse.projects
  for update to authenticated
  using (pulse.rank_in(workspace_id) >= 50)
  with check (pulse.rank_in(workspace_id) >= 50);

drop policy if exists projects_delete on pulse.projects;
create policy projects_delete on pulse.projects
  for delete to authenticated
  using (pulse.rank_in(workspace_id) >= 50);

-- brand_profiles
drop policy if exists brand_select on pulse.brand_profiles;
create policy brand_select on pulse.brand_profiles
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

drop policy if exists brand_insert on pulse.brand_profiles;
create policy brand_insert on pulse.brand_profiles
  for insert to authenticated with check (pulse.rank_in_project(project_id) >= 40);

drop policy if exists brand_update on pulse.brand_profiles;
create policy brand_update on pulse.brand_profiles
  for update to authenticated
  using (pulse.rank_in_project(project_id) >= 40)
  with check (pulse.rank_in_project(project_id) >= 40);

-- social_accounts: интеграции — дело admin
drop policy if exists social_select on pulse.social_accounts;
create policy social_select on pulse.social_accounts
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

drop policy if exists social_insert on pulse.social_accounts;
create policy social_insert on pulse.social_accounts
  for insert to authenticated with check (pulse.rank_in_project(project_id) >= 50);

drop policy if exists social_update on pulse.social_accounts;
create policy social_update on pulse.social_accounts
  for update to authenticated
  using (pulse.rank_in_project(project_id) >= 50)
  with check (pulse.rank_in_project(project_id) >= 50);

drop policy if exists social_delete on pulse.social_accounts;
create policy social_delete on pulse.social_accounts
  for delete to authenticated using (pulse.rank_in_project(project_id) >= 50);

-- content_items
drop policy if exists content_select on pulse.content_items;
create policy content_select on pulse.content_items
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

drop policy if exists content_insert on pulse.content_items;
create policy content_insert on pulse.content_items
  for insert to authenticated with check (pulse.rank_in_project(project_id) >= 40);

drop policy if exists content_update on pulse.content_items;
create policy content_update on pulse.content_items
  for update to authenticated
  using (pulse.rank_in_project(project_id) >= 40)
  with check (pulse.rank_in_project(project_id) >= 40);

drop policy if exists content_delete on pulse.content_items;
create policy content_delete on pulse.content_items
  for delete to authenticated using (pulse.rank_in_project(project_id) >= 50);

-- platform_variants
drop policy if exists variants_select on pulse.platform_variants;
create policy variants_select on pulse.platform_variants
  for select to authenticated
  using (pulse.rank_in_project(pulse.project_of_variant(id)) > 0);

drop policy if exists variants_insert on pulse.platform_variants;
create policy variants_insert on pulse.platform_variants
  for insert to authenticated
  with check (
    pulse.rank_in_project(
      (select c.project_id from pulse.content_items c where c.id = content_item_id)
    ) >= 40
  );

drop policy if exists variants_update on pulse.platform_variants;
create policy variants_update on pulse.platform_variants
  for update to authenticated
  using (pulse.rank_in_project(pulse.project_of_variant(id)) >= 40)
  with check (pulse.rank_in_project(pulse.project_of_variant(id)) >= 40);

drop policy if exists variants_delete on pulse.platform_variants;
create policy variants_delete on pulse.platform_variants
  for delete to authenticated
  using (pulse.rank_in_project(pulse.project_of_variant(id)) >= 40);

-- variant_revisions: история не переписывается, только дописывается
drop policy if exists revisions_select on pulse.variant_revisions;
create policy revisions_select on pulse.variant_revisions
  for select to authenticated
  using (pulse.rank_in_project(pulse.project_of_variant(variant_id)) > 0);

drop policy if exists revisions_insert on pulse.variant_revisions;
create policy revisions_insert on pulse.variant_revisions
  for insert to authenticated
  with check (pulse.rank_in_project(pulse.project_of_variant(variant_id)) >= 40);

-- assets
drop policy if exists assets_select on pulse.assets;
create policy assets_select on pulse.assets
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

drop policy if exists assets_insert on pulse.assets;
create policy assets_insert on pulse.assets
  for insert to authenticated with check (pulse.rank_in_project(project_id) >= 40);

drop policy if exists assets_delete on pulse.assets;
create policy assets_delete on pulse.assets
  for delete to authenticated using (pulse.rank_in_project(project_id) >= 40);

-- approvals: просит editor, решает approver
drop policy if exists approvals_select on pulse.approvals;
create policy approvals_select on pulse.approvals
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

drop policy if exists approvals_insert on pulse.approvals;
create policy approvals_insert on pulse.approvals
  for insert to authenticated
  with check (pulse.rank_in_project(project_id) >= 40 and requested_by = pulse.me());

-- решает только тот, чья роль называется «решать»: editor сюда не входит,
-- хотя по рангу он выше approver'а
drop policy if exists approvals_update on pulse.approvals;
create policy approvals_update on pulse.approvals
  for update to authenticated
  using (pulse.role_in_project(project_id) in ('owner', 'admin', 'approver'))
  with check (pulse.role_in_project(project_id) in ('owner', 'admin', 'approver'));

-- schedules
drop policy if exists schedules_select on pulse.schedules;
create policy schedules_select on pulse.schedules
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

drop policy if exists schedules_insert on pulse.schedules;
create policy schedules_insert on pulse.schedules
  for insert to authenticated with check (pulse.rank_in_project(project_id) >= 40);

drop policy if exists schedules_update on pulse.schedules;
create policy schedules_update on pulse.schedules
  for update to authenticated
  using (pulse.rank_in_project(project_id) >= 40)
  with check (pulse.rank_in_project(project_id) >= 40);

drop policy if exists schedules_delete on pulse.schedules;
create policy schedules_delete on pulse.schedules
  for delete to authenticated using (pulse.rank_in_project(project_id) >= 40);

-- publish_jobs и publications: приложение только смотрит, пишет worker
drop policy if exists jobs_select on pulse.publish_jobs;
create policy jobs_select on pulse.publish_jobs
  for select to authenticated
  using (
    pulse.rank_in_project(
      (select s.project_id from pulse.schedules s where s.id = schedule_id)
    ) > 0
  );

drop policy if exists publications_select on pulse.publications;
create policy publications_select on pulse.publications
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

-- metric_snapshots: analyst и выше вводит руками
drop policy if exists metrics_select on pulse.metric_snapshots;
create policy metrics_select on pulse.metric_snapshots
  for select to authenticated
  using (
    pulse.rank_in_project(
      (select p.project_id from pulse.publications p where p.id = publication_id)
    ) > 0
  );

drop policy if exists metrics_insert on pulse.metric_snapshots;
create policy metrics_insert on pulse.metric_snapshots
  for insert to authenticated
  with check (
    pulse.rank_in_project(
      (select p.project_id from pulse.publications p where p.id = publication_id)
    ) >= 20
  );

drop policy if exists metrics_update on pulse.metric_snapshots;
create policy metrics_update on pulse.metric_snapshots
  for update to authenticated
  using (
    pulse.rank_in_project(
      (select p.project_id from pulse.publications p where p.id = publication_id)
    ) >= 20
  )
  with check (
    pulse.rank_in_project(
      (select p.project_id from pulse.publications p where p.id = publication_id)
    ) >= 20
  );

-- automation_rules
drop policy if exists rules_select on pulse.automation_rules;
create policy rules_select on pulse.automation_rules
  for select to authenticated using (pulse.rank_in_project(project_id) > 0);

drop policy if exists rules_write on pulse.automation_rules;
create policy rules_write on pulse.automation_rules
  for insert to authenticated with check (pulse.rank_in_project(project_id) >= 50);

drop policy if exists rules_update on pulse.automation_rules;
create policy rules_update on pulse.automation_rules
  for update to authenticated
  using (pulse.rank_in_project(project_id) >= 50)
  with check (pulse.rank_in_project(project_id) >= 50);

-- audit_logs: только чтение, и только admin. Пишет привилегированный путь.
drop policy if exists audit_select on pulse.audit_logs;
create policy audit_select on pulse.audit_logs
  for select to authenticated using (pulse.rank_in(workspace_id) >= 50);

drop policy if exists events_select on pulse.events;
create policy events_select on pulse.events
  for select to authenticated using (pulse.rank_in(workspace_id) >= 20);

-- ─────────────────────────────────────────────────────────────
-- Права.
--
-- Секретные колонки social_accounts не входят в grant: роль
-- authenticated физически не может их прочитать.
-- ─────────────────────────────────────────────────────────────

grant usage on schema pulse to authenticated;

grant execute on function
  pulse.current_tg_id(), pulse.me(), pulse.rank_in(uuid),
  pulse.rank_in_project(uuid), pulse.role_in_project(uuid),
  pulse.workspace_of_project(uuid), pulse.project_of_variant(uuid)
  to authenticated;

grant select on pulse.roles to authenticated;
grant select, update on pulse.users to authenticated;
grant select, update, delete on pulse.workspaces to authenticated;
grant select, insert, update, delete on pulse.memberships to authenticated;
grant select, insert, delete on pulse.invitations to authenticated;
grant select, insert, update, delete on pulse.projects to authenticated;
grant select, insert, update on pulse.brand_profiles to authenticated;
grant select, insert, update, delete on pulse.content_items to authenticated;
grant select, insert, update, delete on pulse.platform_variants to authenticated;
grant select, insert on pulse.variant_revisions to authenticated;
grant select, insert, delete on pulse.assets to authenticated;
grant select, insert, update on pulse.approvals to authenticated;
grant select, insert, update, delete on pulse.schedules to authenticated;
grant select on pulse.publish_jobs to authenticated;
grant select on pulse.publications to authenticated;
grant select, insert, update on pulse.metric_snapshots to authenticated;
grant select, insert, update on pulse.automation_rules to authenticated;
grant select on pulse.audit_logs to authenticated;
grant select on pulse.events to authenticated;

-- вставку workspaces делает привилегированный путь: у создателя ещё нет
-- членства, значит rank_in вернёт 0 и with check не пропустит
revoke insert on pulse.workspaces from authenticated;

-- токены наружу не отдаём — грант по колонкам, без секретов
revoke all on pulse.social_accounts from authenticated;
grant select (id, project_id, platform, external_account_id, display_name,
              token_expires_at, permissions_json, status, last_synced_at, created_at)
  on pulse.social_accounts to authenticated;
grant insert (id, project_id, platform, external_account_id, display_name,
              permissions_json, status)
  on pulse.social_accounts to authenticated;
grant update (display_name, status) on pulse.social_accounts to authenticated;
grant delete on pulse.social_accounts to authenticated;

-- anon не участвует: вход только через проверенный initData на сервере
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema pulse from anon';
    execute 'revoke all on schema pulse from anon';
  end if;
end
$$;

commit;
