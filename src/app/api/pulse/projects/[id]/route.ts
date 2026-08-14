import { handle } from '@/lib/pulse/http';
import { getBrand, getProject, listAccounts } from '@/lib/pulse/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Обзор проекта одним запросом: сам проект, бренд-контекст и площадки. */
export async function GET(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const [project, brand, accounts] = await Promise.all([
      getProject(caller.tgId, ctx.params.id),
      getBrand(caller.tgId, ctx.params.id),
      listAccounts(caller.tgId, ctx.params.id),
    ]);
    return { project, brand, accounts };
  });
}
