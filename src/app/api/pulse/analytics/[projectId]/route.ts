import { handle } from '@/lib/pulse/http';
import { digest, listPublications } from '@/lib/pulse/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Разбор проекта: что повторить, что изменить и что больше не делать. */
export async function GET(req: Request, ctx: { params: { projectId: string } }) {
  const explain = new URL(req.url).searchParams.get('explain') === '1';
  return handle(req, async (caller) => {
    const [result, publications] = await Promise.all([
      digest(caller.tgId, ctx.params.projectId, { explain }),
      listPublications(caller.tgId, ctx.params.projectId),
    ]);
    return { ...result, publications };
  });
}
