import { NextResponse } from 'next/server';
import { AuthError, callerFromRequest, type Caller } from './auth';
import { isDbConfigured } from './db/pool';
import { PairError } from './db/pairing';

/**
 * Один каркас на все роуты: сначала подпись, потом всё остальное.
 * Неподтверждённый вызывающий не должен узнавать даже состояние конфигурации.
 */
export async function handle<T>(
  req: Request,
  fn: (caller: Caller) => Promise<T>,
): Promise<NextResponse> {
  let caller: Caller;
  try {
    caller = callerFromRequest(req);
  } catch (e) {
    const detail = e instanceof AuthError ? e.reason : 'AUTH_FAILED';
    return NextResponse.json({ error: 'UNAUTHORIZED', detail }, { status: 401 });
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: 'DB_NOT_CONFIGURED' }, { status: 503 });
  }

  try {
    return NextResponse.json(await fn(caller));
  } catch (e) {
    if (e instanceof PairError) {
      return NextResponse.json({ error: e.code }, { status: 409 });
    }
    console.error('[api]', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
