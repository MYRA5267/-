import { body, handle, str } from '@/lib/pulse/http';
import { reject } from '@/lib/pulse/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ comment: string }>(req);
    return reject(caller.tgId, ctx.params.id, str(input.comment));
  });
}
