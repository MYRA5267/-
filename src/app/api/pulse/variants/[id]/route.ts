import { body, handle, str } from '@/lib/pulse/http';
import { updateVariant } from '@/lib/pulse/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ручная правка. Любая правка после одобрения сбрасывает статус в черновик. */
export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ body: string; firstHook: string; cta: string }>(req);
    return updateVariant(caller.tgId, ctx.params.id, {
      body: input.body === undefined ? undefined : str(input.body),
      firstHook: input.firstHook === undefined ? undefined : str(input.firstHook),
      cta: input.cta === undefined ? undefined : str(input.cta),
    });
  });
}
