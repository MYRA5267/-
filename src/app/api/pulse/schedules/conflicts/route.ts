import { handle, uuid } from '@/lib/pulse/http';
import { findConflicts } from '@/lib/pulse/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Что уже стоит рядом с этим временем.
 *
 * Календарь не запрещает две публикации подряд — он показывает их
 * человеку до того, как тот нажмёт «в очередь».
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const at = params.get('at') ?? new Date().toISOString();
  const window = Number(params.get('window') ?? 30);
  return handle(req, (caller) =>
    findConflicts(caller.tgId, {
      projectId: uuid(params.get('project'), 'PROJECT_REQUIRED'),
      scheduledAt: at,
      windowMinutes: Number.isFinite(window) ? window : 30,
    }),
  );
}
