import { body, handle, oneOf } from '@/lib/pulse/http';
import { createInvitation } from '@/lib/pulse/workspaces';
import { ROLES } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ role: string }>(req);
    return createInvitation(caller.tgId, ctx.params.id, oneOf(input.role, ROLES) ?? 'editor');
  });
}
