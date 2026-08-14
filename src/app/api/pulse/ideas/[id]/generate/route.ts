import { body, handle } from '@/lib/pulse/http';
import { generateForIdea } from '@/lib/pulse/content';
import { PLATFORMS, type Platform } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// генерация под несколько площадок идёт дольше обычного роута
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ platforms: string[]; replace: boolean }>(req);
    const platforms = (Array.isArray(input.platforms) ? input.platforms : []).filter(
      (p): p is Platform => (PLATFORMS as readonly string[]).includes(p),
    );
    return generateForIdea(
      caller.tgId,
      ctx.params.id,
      platforms.length ? platforms : ['telegram', 'threads'],
      { replace: input.replace === true },
    );
  });
}
