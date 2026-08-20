import { body, handle, str } from '@/lib/pulse/http';
import { cancelSchedule, reschedule } from '@/lib/pulse/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Перенос времени — drag-and-drop в календаре. */
export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ scheduledAt: string }>(req);
    return reschedule(caller.tgId, ctx.params.id, str(input.scheduledAt));
  });
}

export async function DELETE(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    await cancelSchedule(caller.tgId, ctx.params.id);
    return { ok: true };
  });
}
