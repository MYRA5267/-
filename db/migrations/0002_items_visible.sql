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
