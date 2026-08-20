import { body, handle, requireOneOf } from '@/lib/pulse/http';
import { applyRewrite } from '@/lib/pulse/content';
import { REWRITE_ACTIONS, type RewriteAction } from '@/lib/pulse/ai/prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ACTIONS = Object.keys(REWRITE_ACTIONS) as RewriteAction[];

export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{ action: string }>(req);
    const action = requireOneOf(input.action, ACTIONS, 'BAD_ACTION');
    return applyRewrite(caller.tgId, ctx.params.id, action);
  });
}
