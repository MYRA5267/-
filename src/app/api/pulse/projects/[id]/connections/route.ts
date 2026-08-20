import { body, handle, requireOneOf, str } from '@/lib/pulse/http';
import { connectAccount, listAccounts } from '@/lib/pulse/projects';
import { PLATFORMS } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: { id: string } }) {
  return handle(req, (caller) => listAccounts(caller.tgId, ctx.params.id));
}

export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<{
      platform: string;
      externalAccountId: string;
      displayName: string;
      token: string;
    }>(req);
    const platform = requireOneOf(input.platform, PLATFORMS, 'BAD_PLATFORM');
    return connectAccount(caller.tgId, {
      projectId: ctx.params.id,
      platform,
      externalAccountId: str(input.externalAccountId),
      displayName: str(input.displayName),
      token: str(input.token) || undefined,
    });
  });
}
