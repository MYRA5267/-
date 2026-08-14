import { handle } from '@/lib/pulse/http';
import { getPack } from '@/lib/pulse/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: { id: string } }) {
  return handle(req, (caller) => getPack(caller.tgId, ctx.params.id));
}
