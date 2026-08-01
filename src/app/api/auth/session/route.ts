import { NextResponse } from 'next/server';
import { AuthError, callerFromRequest } from '@/lib/auth';
import { isDbConfigured } from '@/lib/db/pool';
import { ensureUser, readPairState } from '@/lib/db/pairing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // сначала подпись, потом всё остальное: неподтверждённый вызывающий
  // не должен узнавать даже состояние конфигурации
  let caller;
  try {
    caller = callerFromRequest(req);
  } catch (e) {
    const reason = e instanceof AuthError ? e.reason : 'AUTH_FAILED';
    return NextResponse.json({ error: 'UNAUTHORIZED', detail: reason }, { status: 401 });
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ error: 'DB_NOT_CONFIGURED' }, { status: 503 });
  }

  try {
    await ensureUser(caller.tgId, caller.displayName);
    const state = await readPairState(caller.tgId);
    return NextResponse.json(state);
  } catch (e) {
    console.error('[auth/session]', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
