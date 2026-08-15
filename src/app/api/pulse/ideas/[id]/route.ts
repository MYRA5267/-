import { body, handle, requireOneOf } from '@/lib/pulse/http';
import { setIdeaState } from '@/lib/pulse/content';
import type { IdeaState } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATES: readonly IdeaState[] = ['new', 'in_progress', 'used', 'research', 'later'];

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ state: string }>(req);
    const state = requireOneOf(input.state, STATES, 'BAD_STATE');
    await setIdeaState(caller.tgId, ctx.params.id, state);
    return { ok: true };
  });
}
