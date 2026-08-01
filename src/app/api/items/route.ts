import { handle } from '@/lib/api';
import { createItem } from '@/lib/db/items';
import { readPairState } from '@/lib/db/pairing';
import { classify, firstUrl, hostOf } from '@/lib/classify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const body = (await req.json()) as { text?: unknown; secret?: unknown };
    const raw = typeof body.text === 'string' ? body.text.trim() : '';
    if (!raw) return { error: 'EMPTY' };

    const type = classify(raw);
    const url = firstUrl(raw);
    const host = url ? hostOf(url) : null;

    const pair = await readPairState(caller.tgId);
    // быт — общая корзина, остальное остаётся на том, кто кинул
    const ownerId = type === 'home' ? null : pair.me.id;

    const snapshot = await createItem(caller.tgId, {
      type,
      text: url && host ? `Товар с ${host}` : raw,
      note: url,
      ownerId,
      secret: body.secret === true,
      url,
      rawInput: raw,
    });

    return { ...pair, ...snapshot };
  });
}
