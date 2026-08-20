import { body, handle, optionalUuid, str, uuid } from '@/lib/pulse/http';
import { createProject, listProjects } from '@/lib/pulse/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const workspace = new URL(req.url).searchParams.get('workspace');
  return handle(req, (caller) => listProjects(caller.tgId, optionalUuid(workspace)));
}

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const input = await body<{
      workspaceId: string;
      name: string;
      description: string;
      timezone: string;
    }>(req);
    return createProject(caller.tgId, {
      workspaceId: uuid(input.workspaceId),
      name: str(input.name),
      description: str(input.description),
      timezone: str(input.timezone) || undefined,
    });
  });
}
