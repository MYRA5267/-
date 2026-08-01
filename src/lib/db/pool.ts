import { Pool, type PoolClient } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __obaPool: Pool | undefined;
}

function makePool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL не задан — скопируй .env.example в .env.local');
  }
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    ssl: /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
}

export function pool(): Pool {
  if (!global.__obaPool) global.__obaPool = makePool();
  return global.__obaPool;
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

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
 * Только для того, чего человек про себя ещё не может: завести пару
 * при первом входе и связать двоих по коду. Больше нигде.
 */
export async function withAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
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
