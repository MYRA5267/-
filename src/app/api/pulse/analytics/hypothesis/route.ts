import { body, handle, str, uuid } from '@/lib/pulse/http';
import { acceptHypothesis } from '@/lib/pulse/analytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Гипотеза из разбора возвращается в банк идей — петля замыкается. */
export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const input = await body<{ projectId: string; text: string }>(req);
    const id = await acceptHypothesis(caller.tgId, uuid(input.projectId), str(input.text));
    return { id };
  });
}
