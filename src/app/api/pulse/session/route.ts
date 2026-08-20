import { handle } from '@/lib/pulse/http';
import { ensureUser, listWorkspaces } from '@/lib/pulse/workspaces';
import { listProjects } from '@/lib/pulse/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Первый вызов приложения: кто это, какие у него пространства и проекты. */
export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const me = await ensureUser(caller.tgId, caller.displayName);
    const workspaces = await listWorkspaces(caller.tgId);
    const projects = workspaces.length ? await listProjects(caller.tgId) : [];
    return { me, workspaces, projects, aiConnected: Boolean(process.env.ANTHROPIC_API_KEY) };
  });
}
