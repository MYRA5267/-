import type { PoolClient } from 'pg';
import { withUser } from './pool';
import type { Energy, Item, ItemType, Snapshot } from '../types';

type ItemRow = {
  id: string;
  author_id: string;
  owner_id: string | null;
  type: ItemType;
  text: string;
  note: string | null;
  due_at: Date | null;
  done: boolean;
  claimed_by: string | null;
  secret_owner: string | null;
  url: string | null;
  price: string | null;
  created_at: Date;
};

const toItem = (r: ItemRow): Item => ({
  id: r.id,
  authorId: r.author_id,
  ownerId: r.owner_id,
  type: r.type,
  text: r.text,
  note: r.note,
  dueAt: r.due_at ? r.due_at.toISOString() : null,
  done: r.done,
  claimedBy: r.claimed_by,
  secret: r.secret_owner !== null,
  url: r.url,
  price: r.price,
  createdAt: r.created_at.toISOString(),
});

const SELECT = `
  select id, author_id, owner_id, type, text, note, due_at, done,
         claimed_by, secret_owner, url, price, created_at
  from public.items_visible
  order by done, coalesce(due_at, created_at), created_at desc
`;

/** Всё, что рисует приложение, одним запросом. Realtime нет — перечитываем. */
export async function readSnapshot(tgId: number | string): Promise<Snapshot> {
  return withUser(tgId, async (client) => {
    const items = await client.query<ItemRow>(SELECT);
    const energy = await readEnergy(client);
    return { items: items.rows.map(toItem), energy };
  });
}

async function readEnergy(client: PoolClient): Promise<Energy[]> {
  const { rows } = await client.query<{ user_id: string; level: number }>(
    `select user_id, level from public.energy
     where day = (now() at time zone 'Europe/Amsterdam')::date`,
  );
  return rows.map((r) => ({ userId: r.user_id, level: r.level as 1 | 2 | 3 }));
}

export type NewItem = {
  type: ItemType;
  text: string;
  note: string | null;
  ownerId: string | null;
  secret: boolean;
  url: string | null;
  rawInput: string;
};

export async function createItem(tgId: number | string, item: NewItem): Promise<Snapshot> {
  return withUser(tgId, async (client) => {
    // author_id и couple_id не принимаем с клиента — берём из сессии базы,
    // те же значения проверит `with check` в политике
    await client.query(
      `insert into public.items
         (couple_id, author_id, owner_id, type, text, note, secret_owner, url, raw_input)
       values (
         app.current_couple_id(),
         app.current_user_id(),
         $1, $2, $3, $4,
         case when $5 then app.current_user_id() end,
         $6, $7
       )`,
      [item.ownerId, item.type, item.text, item.note, item.secret, item.url, item.rawInput],
    );
    const items = await client.query<ItemRow>(SELECT);
    return { items: items.rows.map(toItem), energy: await readEnergy(client) };
  });
}

export async function setDone(tgId: number | string, id: string, done: boolean): Promise<Snapshot> {
  return withUser(tgId, async (client) => {
    await client.query('update public.items set done = $2 where id = $1', [id, done]);
    const items = await client.query<ItemRow>(SELECT);
    return { items: items.rows.map(toItem), energy: await readEnergy(client) };
  });
}

/**
 * «Беру на себя». Снять отметку может только тот, кто её поставил —
 * условие `claimed_by is null or claimed_by = app.current_user_id()`
 * не даёт перехватить чужой сюрприз вслепую.
 */
export async function setClaimed(
  tgId: number | string,
  id: string,
  claimed: boolean,
): Promise<Snapshot> {
  return withUser(tgId, async (client) => {
    await client.query(
      `update public.items
       set claimed_by = case when $2 then app.current_user_id() end
       where id = $1
         and (claimed_by is null or claimed_by = app.current_user_id())`,
      [id, claimed],
    );
    const items = await client.query<ItemRow>(SELECT);
    return { items: items.rows.map(toItem), energy: await readEnergy(client) };
  });
}

export async function setEnergy(tgId: number | string, level: 1 | 2 | 3): Promise<Snapshot> {
  return withUser(tgId, async (client) => {
    await client.query(
      `insert into public.energy (couple_id, user_id, day, level)
       values (app.current_couple_id(), app.current_user_id(),
               (now() at time zone 'Europe/Amsterdam')::date, $1)
       on conflict (user_id, day) do update set level = excluded.level`,
      [level],
    );
    const items = await client.query<ItemRow>(SELECT);
    return { items: items.rows.map(toItem), energy: await readEnergy(client) };
  });
}
