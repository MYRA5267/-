import { handle } from '@/lib/pulse/http';
import { inspectVariant } from '@/lib/pulse/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Проверка качества без сохранения: длина, CTA, факты, повторы. */
export async function GET(req: Request, ctx: { params: { id: string } }) {
  return handle(req, async (caller) => ({
    findings: await inspectVariant(caller.tgId, ctx.params.id),
  }));
}
