import { handle } from '@/lib/api';
import { ensureUser, readPairState } from '@/lib/db/pairing';
import { readSnapshot } from '@/lib/db/items';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    await ensureUser(caller.tgId, caller.displayName);
    const pair = await readPairState(caller.tgId);
    const snapshot = await readSnapshot(caller.tgId);
    return { ...pair, ...snapshot };
  });
}
