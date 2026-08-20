import { handle } from '@/lib/pulse/http';
import { testAccount } from '@/lib/pulse/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Проверка доступа без публикации: бот админ канала или нет. */
export async function POST(req: Request, ctx: { params: { id: string } }) {
  return handle(req, (caller) => testAccount(caller.tgId, ctx.params.id));
}
