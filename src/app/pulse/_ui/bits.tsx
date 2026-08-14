'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePulse } from './PulseProvider';
import { STATUS_LABEL } from '@/lib/pulse/status';
import { PLATFORM_SPECS } from '@/lib/pulse/ai/prompts';
import type { Platform, VariantStatus } from '@/lib/pulse/types';
import type { QualityFinding } from '@/lib/pulse/ai/quality';

/** Нижняя навигация. Шесть экранов — больше в MVP не нужно. */
export function Nav({ pending }: { pending?: number }) {
  const path = usePathname();
  const items: Array<[string, string]> = [
    ['/pulse', 'Сегодня'],
    ['/pulse/ideas', 'Идеи'],
    ['/pulse/approvals', 'Решить'],
    ['/pulse/calendar', 'План'],
    ['/pulse/analytics', 'Итоги'],
    ['/pulse/projects', 'Проекты'],
  ];

  return (
    <nav className="nav">
      {items.map(([href, label]) => {
        const current = href === '/pulse' ? path === '/pulse' : path.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={current ? 'page' : undefined}>
            {label}
            {href === '/pulse/approvals' && pending ? (
              <span className="badge">{pending}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Переключатель проекта. Данные проектов не смешиваются — и это видно. */
export function ProjectSwitch() {
  const { session, projectId, setProjectId } = usePulse();
  const projects = session?.projects ?? [];
  if (projects.length === 0) return null;

  return (
    <div className="chips" role="tablist" aria-label="Проект">
      {projects.map((p) => (
        <button
          key={p.id}
          className="chip"
          role="tab"
          aria-pressed={p.id === projectId}
          aria-selected={p.id === projectId}
          onClick={() => setProjectId(p.id)}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}

export function Status({ status }: { status: VariantStatus }) {
  const tone =
    status === 'PUBLISHED' || status === 'ANALYZED'
      ? 'tag-ok'
      : status === 'APPROVED' || status === 'SCHEDULED'
        ? 'tag-on'
        : STATUS_LABEL[status] && status.startsWith('FAILED')
          ? 'tag-warn'
          : '';
  return <span className={`tag ${tone}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function PlatformTag({ platform }: { platform: Platform }) {
  return <span className="tag">{PLATFORM_SPECS[platform].label}</span>;
}

/** Результат проверки качества: блокирующее, предупреждение, вопрос человеку. */
export function Findings({ findings }: { findings: QualityFinding[] }) {
  if (!findings.length) {
    return <p className="mono dim">Проверка прошла: длина, CTA, повторы и факты в порядке.</p>;
  }
  return (
    <div>
      {findings.map((f, i) => (
        <div className="finding" key={`${f.code}-${i}`}>
          <span className={`mono finding-${f.level}`}>
            {f.level === 'block' ? 'стоп' : f.level === 'warn' ? 'слабо' : 'проверь'}
          </span>
          <span className="grow">{f.message}</span>
        </div>
      ))}
    </div>
  );
}

export function Loading({ what = 'Проявляется' }: { what?: string }) {
  return <div className="empty">{what}…</div>;
}

export function Err({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="err">{text}</div>;
}

/** Время в поясе проекта, а не сервера. */
export function when(iso: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString('ru-RU');
  }
}

/** Значение для input[type=datetime-local] — он работает в локальном времени. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
