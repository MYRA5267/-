import { body, handle, oneOf, str } from '@/lib/pulse/http';
import { createIdea, listIdeas } from '@/lib/pulse/content';
import type { IdeaState, Objective } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATES: readonly IdeaState[] = ['new', 'in_progress', 'used', 'research', 'later'];
const OBJECTIVES: readonly Objective[] = ['reach', 'trust', 'click', 'lead', 'sale'];

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const projectId = params.get('project') ?? '';
  const filter = oneOf(params.get('state'), STATES);
  return handle(req, (caller) => listIdeas(caller.tgId, projectId, filter));
}

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const input = await body<{
      projectId: string;
      sourceText: string;
      title: string;
      objective: string;
      audience: string;
    }>(req);
    return createIdea(caller.tgId, {
      projectId: str(input.projectId),
      sourceText: str(input.sourceText),
      title: str(input.title) || undefined,
      objective: oneOf(input.objective, OBJECTIVES),
      audience: str(input.audience),
    });
  });
}
