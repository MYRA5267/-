import { body, handle, str } from '@/lib/pulse/http';
import { createProject, listProjects } from '@/lib/pulse/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get('workspace') ?? undefined;
  return handle(req, (caller) => listProjects(caller.tgId, workspaceId));
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
      workspaceId: str(input.workspaceId),
      name: str(input.name),
      description: str(input.description),
      timezone: str(input.timezone) || undefined,
    });
  });
}
