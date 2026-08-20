import { body, handle, optionalUuid, str, uuid } from '@/lib/pulse/http';
import { listSchedules, schedulePublication } from '@/lib/pulse/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const now = new Date();
  const from = params.get('from') ?? new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const to = params.get('to') ?? new Date(now.getTime() + 30 * 86_400_000).toISOString();
  return handle(req, (caller) =>
    listSchedules(caller.tgId, { from, to, projectId: optionalUuid(params.get('project')) }),
  );
}

export async function POST(req: Request) {
  return handle(req, async (caller) => {
    const input = await body<{
      variantId: string;
      scheduledAt: string;
      socialAccountId: string;
    }>(req);
    return schedulePublication(caller.tgId, {
      variantId: uuid(input.variantId),
      scheduledAt: str(input.scheduledAt),
      socialAccountId: str(input.socialAccountId) || undefined,
    });
  });
}
