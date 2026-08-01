import { NextResponse } from 'next/server';
import { AuthError, callerFromRequest } from '@/lib/auth';
import { isDbConfigured } from '@/lib/db/pool';
import { PairError, ensureUser, joinCouple, readPairState } from '@/lib/db/pairing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
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

  let code = '';
  try {
    const body = (await req.json()) as { code?: unknown };
    code = typeof body.code === 'string' ? body.code : '';
  } catch {
    /* пустое тело — упадём на проверке ниже */
  }
  if (!/^[A-Za-z0-9]{6}$/.test(code.trim())) {
    return NextResponse.json({ error: 'INVALID_CODE' }, { status: 400 });
  }

  try {
    await ensureUser(caller.tgId, caller.displayName);
    await joinCouple(caller.tgId, code);
    const state = await readPairState(caller.tgId);
    return NextResponse.json(state);
  } catch (e) {
    if (e instanceof PairError) {
      return NextResponse.json({ error: e.code }, { status: 409 });
    }
    console.error('[pair/join]', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
