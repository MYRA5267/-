import type { PoolClient } from 'pg';
import { withAdmin, withUser } from './pool';
import type { Ink, PairState, Person } from '../types';

export class PairError extends Error {
  constructor(
    public code: 'INVALID_CODE' | 'COUPLE_FULL' | 'ALREADY_PAIRED' | 'OWN_CODE',
    message?: string,
  ) {
    super(message ?? code);
  }
}

type UserRow = {
  id: string;
  tg_id: string;
  couple_id: string;
  display_name: string;
  ink: Ink;
};

const toPerson = (r: UserRow): Person => ({
  id: r.id,
  tgId: String(r.tg_id),
  displayName: r.display_name,
  ink: r.ink,
});

async function findUser(client: PoolClient, tgId: number | string) {
  const { rows } = await client.query<UserRow>(
    'select id, tg_id, couple_id, display_name, ink from public.users where tg_id = $1',
    [String(tgId)],
  );
  return rows[0] ?? null;
}

/**
 * Первый вход: создаём пару и человека в ней. Идемпотентно.
 * Привилегированный путь — своей строки в users у человека ещё нет,
 * значит RLS про него ничего не знает.
 */
export async function ensureUser(
  tgId: number | string,
  displayName: string,
): Promise<UserRow> {
  return withAdmin(async (client) => {
    const existing = await findUser(client, tgId);
    if (existing) {
      if (displayName && displayName !== existing.display_name) {
        await client.query('update public.users set display_name = $2 where id = $1', [
          existing.id,
          displayName,
        ]);
        existing.display_name = displayName;
      }
      return existing;
    }

    const { rows: coupleRows } = await client.query<{ id: string }>(
      'insert into public.couples default values returning id',
    );
    const coupleId = coupleRows[0].id;

    const { rows } = await client.query<UserRow>(
      `insert into public.users (tg_id, couple_id, display_name, ink)
       values ($1, $2, $3, 'blue')
       returning id, tg_id, couple_id, display_name, ink`,
      [String(tgId), coupleId, displayName],
    );
    return rows[0];
  });
}

/**
 * Состояние связки читается уже под RLS — тем же путём, что и весь
 * остальной продукт. Если политика сломается, это увидим здесь первым.
 */
export async function readPairState(tgId: number | string): Promise<PairState> {
  return withUser(tgId, async (client) => {
    const { rows: users } = await client.query<UserRow>(
      'select id, tg_id, couple_id, display_name, ink from public.users order by created_at',
    );
    const me = users.find((u) => String(u.tg_id) === String(tgId));
    if (!me) throw new Error('RLS не отдал собственную строку пользователя');

    const { rows: couples } = await client.query<{ id: string; invite_code: string }>(
      'select id, invite_code from public.couples',
    );
    const couple = couples[0];
    if (!couple) throw new Error('RLS не отдал пару');

    const partner = users.find((u) => u.id !== me.id) ?? null;

    return {
      me: toPerson(me),
      partner: partner ? toPerson(partner) : null,
      couple: { id: couple.id, inviteCode: couple.invite_code },
    };
  });
}

/**
 * Связка по коду. Закрывается навсегда: третьего в паре не даст
 * ограничение unique(couple_id, ink) на уровне базы, а не проверка тут.
 */
export async function joinCouple(tgId: number | string, rawCode: string): Promise<void> {
  const code = rawCode.trim().toUpperCase();

  await withAdmin(async (client) => {
    const me = await findUser(client, tgId);
    if (!me) throw new PairError('INVALID_CODE', 'нет пользователя');

    const { rows: targets } = await client.query<{ id: string }>(
      'select id from public.couples where invite_code = $1 for update',
      [code],
    );
    const target = targets[0];
    if (!target) throw new PairError('INVALID_CODE');
    if (target.id === me.couple_id) throw new PairError('OWN_CODE');

    const { rows: members } = await client.query<{ id: string; ink: Ink }>(
      'select id, ink from public.users where couple_id = $1',
      [target.id],
    );
    if (members.length >= 2) throw new PairError('COUPLE_FULL');

    // из уже сложившейся пары не уходят
    const { rows: mates } = await client.query<{ id: string }>(
      'select id from public.users where couple_id = $1 and id <> $2',
      [me.couple_id, me.id],
    );
    if (mates.length > 0) throw new PairError('ALREADY_PAIRED');

    const taken = new Set(members.map((m) => m.ink));
    const ink: Ink = taken.has('blue') ? 'pink' : 'blue';

    const oldCoupleId = me.couple_id;

    // то, что человек успел накидать до связки, переезжает вместе с ним
    await client.query('update public.items set couple_id = $1 where couple_id = $2', [
      target.id,
      oldCoupleId,
    ]);
    await client.query('update public.energy set couple_id = $1 where couple_id = $2', [
      target.id,
      oldCoupleId,
    ]);
    await client.query('update public.users set couple_id = $1, ink = $2 where id = $3', [
      target.id,
      ink,
      me.id,
    ]);
    await client.query(
      `delete from public.couples c
       where c.id = $1 and not exists (select 1 from public.users u where u.couple_id = c.id)`,
      [oldCoupleId],
    );
  });
}
