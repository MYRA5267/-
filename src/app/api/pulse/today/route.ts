import { handle, optionalUuid } from '@/lib/pulse/http';
import { todayFor } from '@/lib/pulse/today';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  return handle(req, (caller) =>
    todayFor(caller.tgId, {
      workspaceId: optionalUuid(params.get('workspace')),
      projectId: optionalUuid(params.get('project')),
    }),
  );
}
