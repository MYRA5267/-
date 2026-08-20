import { NextResponse } from 'next/server';
import { isDbConfigured } from '@/lib/pulse/db';
import { handleUpdate } from '@/lib/pulse/bot/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook бота.
 *
 * Telegram присылает сюда обновления и повторяет доставку на любой
 * не-200 ответ. Поэтому отвечаем 200 почти всегда: ошибка внутри
 * обработчика не должна превращаться в бесконечный поток повторов.
 *
 * Подлинность запроса — по секретному заголовку, который Telegram
 * присылает ровно тот, что мы задали при setWebhook.
 */
export async function POST(req: Request) {
  const expected = process.env.PULSE_TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'WEBHOOK_NOT_CONFIGURED' }, { status: 503 });
  }
  const got = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!timingSafeEqual(got, expected)) {
    // чужой запрос не должен узнать даже про состояние конфигурации
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json({ error: 'DB_NOT_CONFIGURED' }, { status: 503 });
  }

  let update: unknown;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  await handleUpdate(update as Parameters<typeof handleUpdate>[0]);
  return NextResponse.json({ ok: true });
}

/** Сравнение без ранней остановки на первом различии. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
