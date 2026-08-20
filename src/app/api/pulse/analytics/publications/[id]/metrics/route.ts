import { body, handle, num, oneOf } from '@/lib/pulse/http';
import { saveMetrics, type Horizon } from '@/lib/pulse/analytics';
import type { MetricInput } from '@/lib/pulse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HORIZONS: readonly Horizon[] = ['h24', 'h72', 'd7', 'manual'];

/** Ручной ввод метрик: то, что площадка не отдаёт по API. */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => {
    const input = await body<Record<string, unknown>>(req);
    const metrics: MetricInput = {
      views: num(input.views),
      reach: num(input.reach),
      likes: num(input.likes),
      replies: num(input.replies),
      reposts: num(input.reposts),
      saves: num(input.saves),
      profileVisits: num(input.profileVisits),
      linkClicks: num(input.linkClicks),
      watchTime: num(input.watchTime),
      completionRate: num(input.completionRate),
    };
    await saveMetrics(caller.tgId, ctx.params.id, metrics, oneOf(input.horizon, HORIZONS));
    return { ok: true };
  });
}
