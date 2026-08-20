import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

export { isDbConfigured } from '../db/pool';

/**
 * Запрос от имени человека: роль `authenticated` + `app.tg_id`.
 * Всё, что здесь выполняется, проходит через RLS. Обычный путь приложения.
 */
export async function withUser<T>(
  tgId: number | string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', ['app.tg_id', String(tgId)]);
    await client.query('set local search_path = pulse, public');
    await client.query('set local role authenticated');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Привилегированный путь — владелец схемы, RLS не действует.
 * Только там, где человек про себя ещё ничего не может: завести себя при
 * первом входе, создать пространство, войти по коду приглашения, а также
 * worker — он публикует и читает токены, за которыми в RLS-путь не пускают.
 */
export async function withAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    await client.query('set local search_path = pulse, public');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Доменная ошибка: понятный код наружу вместо стектрейса Postgres. */
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Недостаточно прав — RLS вернул ноль строк там, где ждали одну. */
export function assertTouched(rowCount: number | null, code = 'FORBIDDEN'): void {
  if (!rowCount) throw new DomainError(code, 403);
}
