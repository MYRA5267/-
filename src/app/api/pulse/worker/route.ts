import { NextResponse } from 'next/server';
import { isServiceCall } from '@/lib/pulse/auth';
import { isDbConfigured } from '@/lib/pulse/db';
import { tick } from '@/lib/pulse/publish';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Один проход очереди. Вызывается по расписанию (cron платформы или
 * scripts/pulse-worker.mjs), а не человеком: доступ по служебному секрету.
 */
/** Планировщик платформы ходит GET'ом — принимаем оба способа. */
export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  if (!isServiceCall(req)) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: 'DB_NOT_CONFIGURED' }, { status: 503 });
  }
  try {
    const limit = Number(new URL(req.url).searchParams.get('limit') ?? 10);
    return NextResponse.json(await tick(Number.isFinite(limit) ? limit : 10));
  } catch (e) {
    console.error('[pulse/worker]', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
