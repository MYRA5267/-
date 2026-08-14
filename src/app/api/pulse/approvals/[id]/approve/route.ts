import { body, handle, str } from '@/lib/pulse/http';
import { approve, approveAll } from '@/lib/pulse/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Одобрение одной версии — или всего пакета, если вместо id согласования
 * пришёл id материала с флагом all.
 */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ comment: string; all: boolean }>(req);
    if (input.all === true) return approveAll(caller.tgId, ctx.params.id);
    return approve(caller.tgId, ctx.params.id, str(input.comment));
  });
}
