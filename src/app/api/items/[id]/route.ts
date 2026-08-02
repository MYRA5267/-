import { handle } from '@/lib/api';
import { setClaimed, setDone } from '@/lib/db/items';
import { readPairState } from '@/lib/db/pairing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const body = (await req.json()) as { done?: unknown; claimed?: unknown };

    const snapshot =
      typeof body.done === 'boolean'
        ? await setDone(caller.tgId, params.id, body.done)
        : await setClaimed(caller.tgId, params.id, body.claimed === true);

    const pair = await readPairState(caller.tgId);
    return { ...pair, ...snapshot };
  });
}
