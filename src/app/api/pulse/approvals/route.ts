import { handle } from '@/lib/pulse/http';
import { listPending } from '@/lib/pulse/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get('project') ?? undefined;
  return handle(req, (caller) => listPending(caller.tgId, projectId));
}
