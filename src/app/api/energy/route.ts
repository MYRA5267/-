import { handle } from '@/lib/api';
import { setEnergy } from '@/lib/db/items';
import { readPairState } from '@/lib/db/pairing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const body = (await req.json()) as { level?: unknown };
    const level = Number(body.level);
    if (![1, 2, 3].includes(level)) return { error: 'BAD_LEVEL' };

    const snapshot = await setEnergy(caller.tgId, level as 1 | 2 | 3);
    const pair = await readPairState(caller.tgId);
    return { ...pair, ...snapshot };
  });
}
