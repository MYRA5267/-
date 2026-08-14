import { handle } from '@/lib/pulse/http';
import { disconnectAccount } from '@/lib/pulse/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    await disconnectAccount(caller.tgId, ctx.params.id);
    return { ok: true };
  });
}
