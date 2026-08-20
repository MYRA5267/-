import { NextResponse } from 'next/server';
import { AuthError, callerFromRequest } from '@/lib/pulse/auth';
import { getPack } from '@/lib/pulse/content';
import { getProject } from '@/lib/pulse/projects';
import { buildExportPackage, flattenPackage } from '@/lib/pulse/connectors/export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Экспорт-пакет для неподключённых площадок: один файл, который человек
 * скачивает и загружает руками. Отдаём текстом, а не JSON — это файл.
 */
export async function GET(req: Request, ctx: { params: { id: string } }) {
  let caller;
  try {
    caller = callerFromRequest(req);
  } catch (e) {
    const reason = e instanceof AuthError ? e.reason : 'AUTH_FAILED';
    return NextResponse.json({ error: 'UNAUTHORIZED', detail: reason }, { status: 401 });
  }

  try {
    const pack = await getPack(caller.tgId, ctx.params.id);
    const project = await getProject(caller.tgId, pack.item.projectId);
    const built = buildExportPackage(pack, project.name);
    return new NextResponse(flattenPackage(built), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${built.fileName}.txt"`,
      },
    });
  } catch (e) {
    console.error('[pulse/export]', e);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
