import { body, handle, str } from '@/lib/pulse/http';
import { requestApproval } from '@/lib/pulse/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const input = await body<{ variantId: string }>(req);
    return requestApproval(caller.tgId, str(input.variantId));
  });
}
