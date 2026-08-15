import { handle, optionalUuid } from '@/lib/pulse/http';
import { listPending } from '@/lib/pulse/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const project = new URL(req.url).searchParams.get('project');
  return handle(req, (caller) => listPending(caller.tgId, optionalUuid(project)));
}
