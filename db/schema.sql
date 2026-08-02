-- ОБА — вся схема одним файлом.
--
-- Открой консоль базы (в Neon: Project → SQL Editor), вставь этот файл
-- целиком и нажми Run. Повторный запуск безопасен — миграции идемпотентны.
--
-- Собрано из db/migrations/*.sql. Правь миграции, а не этот файл:
--   node scripts/build-schema.mjs

-- ─── 0001_init.sql ───────────────────────────────────────────────

-- ОБА — базовая схема: пара, люди, пункты, энергия.
-- Мультитенантность на уровне «пара». Изоляция обеспечивается RLS,
-- а не кодом приложения.
--
-- Контракт с приложением: каждый запрос от имени человека выполняется
-- внутри транзакции, где выставлены
--   set local role authenticated;
--   select set_config('app.tg_id', '<tg_id>', true);
-- Всё остальное решают политики ниже.

begin;

-- gen_random_uuid() живёт в ядре с Postgres 13, pgcrypto для неё не нужен.
-- vector нужен только для `embedding` («Спроси у нас», п. 9) — он добавляется
-- ниже, отдельно и необязательно, чтобы недоступное расширение не роняло
-- всю схему.

-- Роль `authenticated` есть в Supabase из коробки; на Neon и любом другом
-- голом Postgres создаём сами.
--
-- Грант обязателен: `set local role authenticated` требует, чтобы
-- подключающаяся роль состояла в целевой. В Supabase `postgres` уже член
-- `authenticated`, поэтому там это работает само; больше нигде — нет.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;

  -- Членства мало: в Postgres 16 роль, созданную CREATEROLE-пользователем,
  -- сервер грантит создателю с admin, но с set_option = false. Членство есть,
  -- `set role` запрещён. Проверять надо именно право SET.
  if current_setting('server_version_num')::int >= 160000 then
    if not pg_has_role(current_user, 'authenticated', 'set') then
      execute format('grant authenticated to %I with set true', current_user);
    end if;
  elsif not pg_has_role(current_user, 'authenticated', 'member') then
    execute format('grant authenticated to %I', current_user);
  end if;
end
$$;

create schema if not exists app;

-- ─────────────────────────────────────────────────────────────
-- Таблицы
-- ─────────────────────────────────────────────────────────────

create table if not exists public.couples (
  id          uuid primary key default gen_random_uuid(),
  invite_code text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.users (
  id           uuid primary key default gen_random_uuid(),
  tg_id        bigint not null unique,
  couple_id    uuid not null references public.couples(id) on delete cascade,
  display_name text not null default '',
  ink          text not null check (ink in ('blue', 'pink')),
  created_at   timestamptz not null default now(),
  -- один синий, один розовый: третьего в паре физически не может быть
  unique (couple_id, ink)
);

create index if not exists users_couple_idx on public.users (couple_id);

create table if not exists public.items (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null references public.couples(id) on delete cascade,
  author_id    uuid not null references public.users(id) on delete cascade,
  owner_id     uuid references public.users(id) on delete set null,  -- null = общее
  type         text not null check (type in ('task', 'wish', 'home', 'date')),
  text         text not null,
  note         text,
  due_at       timestamptz,
  done         boolean not null default false,
  escalated_at timestamptz,                                          -- когда напарнику ушёл пинг
  claimed_by   uuid references public.users(id) on delete set null,  -- СЕКРЕТ: кто берёт желание
  secret_owner uuid references public.users(id) on delete cascade,   -- СЕКРЕТ: пункт видит только он
  url          text,
  price        text,
  image_url    text,
  raw_input    text,                                                 -- что человек написал дословно
  created_at   timestamptz not null default now()
);

-- embedding для «Спроси у нас» (п. 9). Если pgvector на хостинге недоступен,
-- схема всё равно встаёт целиком — колонка добавится, когда дойдём до поиска.
do $$
declare has_vector boolean := false;
begin
  begin
    create extension if not exists vector;
    has_vector := true;
  exception when others then
    raise notice 'pgvector недоступен: колонка items.embedding пропущена, «Спроси у нас» подключим позже';
  end;
  if has_vector then
    execute 'alter table public.items add column if not exists embedding vector(1536)';
  end if;
end
$$;

create index if not exists items_couple_type_idx on public.items (couple_id, type, done);
create index if not exists items_due_idx on public.items (couple_id, due_at)
  where done = false and due_at is not null;
create index if not exists items_secret_idx on public.items (secret_owner)
  where secret_owner is not null;

create table if not exists public.energy (
  id         uuid primary key default gen_random_uuid(),
  couple_id  uuid not null references public.couples(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  day        date not null default (now() at time zone 'Europe/Amsterdam')::date,
  level      smallint not null check (level between 1 and 3),
  created_at timestamptz not null default now(),
  unique (user_id, day)
);

-- ─────────────────────────────────────────────────────────────
-- Текущий человек. security definer — чтобы политика на users
-- не рекурсировала сама в себя при чтении users.
-- ─────────────────────────────────────────────────────────────

create or replace function app.current_tg_id() returns bigint
  language sql stable
as $$
  select nullif(current_setting('app.tg_id', true), '')::bigint
$$;

create or replace function app.current_user_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select u.id from public.users u where u.tg_id = app.current_tg_id()
$$;

create or replace function app.current_couple_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp
as $$
  select u.couple_id from public.users u where u.tg_id = app.current_tg_id()
$$;

-- Код-приглашение: 6 символов, без похожих друг на друга (0/O, 1/I/L, 2/Z, 5/S, 8/B).
create or replace function app.gen_invite_code() returns text
  language plpgsql volatile set search_path = public, pg_temp
as $$
declare
  alphabet constant text := 'ACDEFGHJKMNPQRTUVWXY34679';
  code text;
begin
  loop
    code := '';
    for _i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.couples c where c.invite_code = code);
  end loop;
  return code;
end
$$;

alter table public.couples alter column invite_code set default app.gen_invite_code();

-- ─────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────

alter table public.couples enable row level security;
alter table public.users   enable row level security;
alter table public.items   enable row level security;
alter table public.energy  enable row level security;

drop policy if exists couples_select on public.couples;
create policy couples_select on public.couples
  for select to authenticated
  using (id = app.current_couple_id());

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using (couple_id = app.current_couple_id());

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id() and couple_id = app.current_couple_id());

-- items: изоляция по паре + секретный слой.
-- `secret_owner` проверяется здесь один раз — дальше секретный пункт
-- физически не выходит из Postgres к партнёру: ни в списке, ни в поиске,
-- ни в cron-уведомлениях, ни в отпечатке недели.
drop policy if exists items_select on public.items;
create policy items_select on public.items
  for select to authenticated
  using (
    couple_id = app.current_couple_id()
    and (secret_owner is null or secret_owner = app.current_user_id())
  );

drop policy if exists items_insert on public.items;
create policy items_insert on public.items
  for insert to authenticated
  with check (
    couple_id = app.current_couple_id()
    and author_id = app.current_user_id()
    and (secret_owner is null or secret_owner = app.current_user_id())
  );

drop policy if exists items_update on public.items;
create policy items_update on public.items
  for update to authenticated
  using (
    couple_id = app.current_couple_id()
    and (secret_owner is null or secret_owner = app.current_user_id())
  )
  with check (
    couple_id = app.current_couple_id()
    and (secret_owner is null or secret_owner = app.current_user_id())
  );

drop policy if exists items_delete on public.items;
create policy items_delete on public.items
  for delete to authenticated
  using (
    couple_id = app.current_couple_id()
    and (secret_owner is null or secret_owner = app.current_user_id())
  );

-- energy: видно обоим (в этом весь смысл), пишет каждый только за себя.
drop policy if exists energy_select on public.energy;
create policy energy_select on public.energy
  for select to authenticated
  using (couple_id = app.current_couple_id());

drop policy if exists energy_insert on public.energy;
create policy energy_insert on public.energy
  for insert to authenticated
  with check (couple_id = app.current_couple_id() and user_id = app.current_user_id());

drop policy if exists energy_update on public.energy;
create policy energy_update on public.energy
  for update to authenticated
  using (user_id = app.current_user_id())
  with check (couple_id = app.current_couple_id() and user_id = app.current_user_id());

-- ─────────────────────────────────────────────────────────────
-- Права
-- ─────────────────────────────────────────────────────────────

grant usage on schema public to authenticated;
grant usage on schema app to authenticated;
grant execute on function app.current_tg_id(), app.current_user_id(), app.current_couple_id()
  to authenticated;

grant select on public.couples to authenticated;
grant select, update on public.users to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant select, insert, update, delete on public.energy to authenticated;

-- anon не участвует: вход только через проверенный initData на сервере
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.couples, public.users, public.items, public.energy from anon';
    execute 'revoke all on schema app from anon';
  end if;
end
$$;

-- ─────────────────────────────────────────────────────────────
-- Самопроверка: контракт приложения должен выполняться прямо сейчас.
-- Лучше упасть здесь, чем на первом же запросе живого человека.
-- ─────────────────────────────────────────────────────────────

do $$
begin
  set local role authenticated;
  perform 1 from public.items;   -- пусто, но политика обязана отработать
  reset role;
exception when insufficient_privilege then
  reset role;
  raise exception
    'роль % не может выполнить `set role authenticated` — приложение работать не будет',
    current_user;
end
$$;

commit;


-- ─── 0002_items_visible.sql ──────────────────────────────────────

-- Вью для чтения пунктов. Существует ради одного поля.
--
-- `claimed_by` — кто взял желание на себя. Партнёр не должен видеть ни
-- отметки, ни самого факта её существования: для него карточка не меняется
-- вообще. Поэтому маскируем в SQL, а не в React, и наружу отдаём только
-- это вью — колонка `claimed_by` из `items` на клиент не уходит никогда.
--
-- security_invoker = true обязателен: без него вью читало бы таблицу правами
-- владельца и обошло бы RLS вместе со всем секретным слоем.

begin;

create or replace view public.items_visible
with (security_invoker = true) as
select
  i.id,
  i.couple_id,
  i.author_id,
  i.owner_id,
  i.type,
  i.text,
  i.note,
  i.due_at,
  i.done,
  i.escalated_at,
  case when i.claimed_by = app.current_user_id() then i.claimed_by end as claimed_by,
  i.secret_owner,
  i.url,
  i.price,
  i.image_url,
  i.raw_input,
  i.created_at
from public.items i;

grant select on public.items_visible to authenticated;

commit;
