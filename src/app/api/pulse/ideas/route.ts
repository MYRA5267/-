import { body, handle, oneOf, str, uuid } from '@/lib/pulse/http';
import { createIdea, listIdeas } from '@/lib/pulse/content';
import type { IdeaState, Objective } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATES: readonly IdeaState[] = ['new', 'in_progress', 'used', 'research', 'later'];
const OBJECTIVES: readonly Objective[] = ['reach', 'trust', 'click', 'lead', 'sale'];

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const filter = oneOf(params.get('state'), STATES);
  return handle(req, (caller) =>
    listIdeas(caller.tgId, uuid(params.get('project'), 'PROJECT_REQUIRED'), filter),
  );
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
      projectId: uuid(input.projectId, 'PROJECT_REQUIRED'),
      sourceText: str(input.sourceText),
      title: str(input.title) || undefined,
      objective: oneOf(input.objective, OBJECTIVES),
      audience: str(input.audience),
    });
  });
}
