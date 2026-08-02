-- Проверка, что RLS реально работает, — без терминала и без Node.
--
-- Открой консоль своей базы (в Neon: Project → SQL Editor), вставь этот файл
-- целиком и нажми Run. В конце получишь таблицу с результатами.
--
-- Ничего не портит: всё живёт внутри транзакции, которая в последней строке
-- откатывается. После проверки база остаётся ровно такой, какой была.
--
-- Ждём «прошло» во всех строках. Если хоть одна «ПРОВАЛ» — приложение
-- запускать нельзя: секретный слой протекает.

begin;

-- ── сеем две пары и секретные пункты ────────────────────────────────

insert into public.couples (id, invite_code) values
  ('11111111-1111-1111-1111-111111111111', 'CHK111'),
  ('22222222-2222-2222-2222-222222222222', 'CHK222');

insert into public.users (id, tg_id, couple_id, display_name, ink) values
  ('aaaaaaaa-0000-0000-0000-000000000001', -901, '11111111-1111-1111-1111-111111111111', 'A', 'blue'),
  ('bbbbbbbb-0000-0000-0000-000000000002', -902, '11111111-1111-1111-1111-111111111111', 'B', 'pink'),
  ('cccccccc-0000-0000-0000-000000000003', -903, '22222222-2222-2222-2222-222222222222', 'C', 'blue');

insert into public.items (couple_id, author_id, type, text, secret_owner, claimed_by) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'task', 'общий пункт', null, null),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
   'task', 'секрет A', 'aaaaaaaa-0000-0000-0000-000000000001', null),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002',
   'task', 'секрет B', 'bbbbbbbb-0000-0000-0000-000000000002', null),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-0000-0000-0000-000000000002',
   'wish', 'желание B', null, 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('22222222-2222-2222-2222-222222222222', 'cccccccc-0000-0000-0000-000000000003',
   'task', 'чужая пара', null, null);

create temp table _rls (n int, проверка text, ok boolean, детали text);
grant all on _rls to authenticated;

-- ── читаем базу так же, как это делает приложение ───────────────────

-- A: свой секрет видит, чужой — нет
select set_config('app.tg_id', '-901', true);
set local role authenticated;
insert into _rls
select 1, 'A видит общий пункт и свой секрет',
       string_agg(text, ', ' order by text) = 'общий пункт, секрет A',
       coalesce(string_agg(text, ', ' order by text), '(пусто)')
from public.items_visible where type = 'task';
insert into _rls
select 2, 'секрет B к A не выходит',
       not exists (select 1 from public.items_visible where text = 'секрет B'), '';
insert into _rls
select 3, 'чужая пара к A не выходит',
       not exists (select 1 from public.items_visible where text = 'чужая пара'), '';
insert into _rls
select 4, 'A видит свою отметку «беру на себя»',
       claimed_by = 'aaaaaaaa-0000-0000-0000-000000000001',
       coalesce(claimed_by::text, 'null')
from public.items_visible where text = 'желание B';
reset role;

-- B: своё видит, отметку A — нет
select set_config('app.tg_id', '-902', true);
set local role authenticated;
insert into _rls
select 5, 'B видит общий пункт и свой секрет',
       string_agg(text, ', ' order by text) = 'общий пункт, секрет B',
       coalesce(string_agg(text, ', ' order by text), '(пусто)')
from public.items_visible where type = 'task';
insert into _rls
select 6, 'B НЕ видит, что её желание взяли',
       claimed_by is null, coalesce(claimed_by::text, 'null')
from public.items_visible where text = 'желание B';
insert into _rls
select 7, 'B не может править секрет A', not exists (
  select 1 from public.items_visible where text = 'секрет A'
), '';
reset role;

-- C: другая пара
select set_config('app.tg_id', '-903', true);
set local role authenticated;
insert into _rls
select 8, 'вторая пара видит только своё',
       string_agg(text, ', ' order by text) = 'чужая пара',
       coalesce(string_agg(text, ', ' order by text), '(пусто)')
from public.items_visible;
reset role;

-- без app.tg_id база обязана быть пустой
select set_config('app.tg_id', '', true);
set local role authenticated;
insert into _rls
select 9, 'без app.tg_id база пуста',
       (select count(*) from public.items_visible) = 0,
       (select count(*)::text || ' строк' from public.items_visible);
reset role;

-- ── результат ───────────────────────────────────────────────────────

select
  n as "№",
  проверка,
  case when ok then 'прошло' else 'ПРОВАЛ' end as результат,
  nullif(детали, '') as детали
from _rls
union all
select
  99,
  'ИТОГО',
  count(*) filter (where ok)::text || ' из ' || count(*)::text,
  case when bool_and(ok) then 'RLS держит' else 'НЕ ЗАПУСКАЙ ПРИЛОЖЕНИЕ' end
from _rls
order by 1;

rollback;
