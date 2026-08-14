import { handle } from '@/lib/pulse/http';
import { listMembers } from '@/lib/pulse/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: { id: string } }) {
  return handle(req, (caller) => listMembers(caller.tgId, ctx.params.id));
}
