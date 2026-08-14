import { body, handle } from '@/lib/pulse/http';
import { saveBrand } from '@/lib/pulse/projects';
import type { BrandProfile } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const patch = await body<Omit<BrandProfile, 'projectId'>>(req);
    return saveBrand(caller.tgId, ctx.params.id, patch);
  });
}
