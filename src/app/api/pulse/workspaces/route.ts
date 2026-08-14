import { body, handle, oneOf, str } from '@/lib/pulse/http';
import { createWorkspace, listWorkspaces } from '@/lib/pulse/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TYPES = ['personal', 'product', 'client', 'agency'] as const;

export async function GET(req: Request) {
  return handle(req, (caller) => listWorkspaces(caller.tgId));
}

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const input = await body<{ name: string; type: string }>(req);
    return createWorkspace(caller.tgId, {
      name: str(input.name),
      type: oneOf(input.type, TYPES) ?? 'personal',
    });
  });
}
