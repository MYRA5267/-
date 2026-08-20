import { body, handle, str } from '@/lib/pulse/http';
import { ensureUser, joinByCode } from '@/lib/pulse/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    await ensureUser(caller.tgId, caller.displayName);
    const input = await body<{ code: string }>(req);
    return joinByCode(caller.tgId, str(input.code));
  });
}
