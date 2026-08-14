'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './_ui/api';
import { usePulse } from './_ui/PulseProvider';
import { Eye } from './_ui/Eye';
import { Err, Loading, PlatformTag, ProjectSwitch, when } from './_ui/bits';
import type { Today } from '@/lib/pulse/types';

/**
 * Экран «Сегодня».
 *
 * Одно главное действие, ближайшая публикация, что ждёт решения,
 * ошибки очереди и короткий итог вчерашнего дня. Больше сюда ничего
 * не добавляем: главный экран не должен стать кладбищем графиков.
 */
export default function TodayPage() {
  const { session, loading, error, projectId, project } = usePulse();
  const [today, setToday] = useState<Today | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setToday(await api.get<Today>(`/api/pulse/today?project=${projectId}`));
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;
  if (error) return <div className="wrap section"><Err text={error} /></div>;
  if (!session) return <div className="empty">Открой приложение внутри Telegram</div>;

  // первый запуск: пространства ещё нет
  if (session.workspaces.length === 0 || !projectId) {
    return <FirstRun hasWorkspace={session.workspaces.length > 0} />;
  }

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="display">PULSE</h1>
        <p className="dim" style={{ marginTop: 8 }}>
          {project?.name ?? 'Проект'} · {session.me.name}
        </p>
        <div style={{ marginTop: 16 }}>
          <ProjectSwitch />
        </div>
      </header>

      <section className="section">
        <Eye state={today?.eye ?? 'breathing'} />
        <div style={{ marginTop: 28 }}>
          <p className="label" style={{ marginBottom: 10 }}>Сегодня</p>
          {today ? (
            <Link href={today.focus.href} className="btn btn-main">
              {today.focus.label}
            </Link>
          ) : (
            <div className="btn btn-main" aria-disabled>Собираем картину…</div>
          )}
        </div>
        <Err text={failure} />
      </section>

      {today?.nextPublication ? (
        <section className="section">
          <p className="label">Ближайшая публикация</p>
          <div className="row-between" style={{ marginTop: 12 }}>
            <div className="grow">
              <p style={{ margin: 0, fontWeight: 500 }}>{today.nextPublication.title}</p>
              <p className="mono dim" style={{ margin: '4px 0 0' }}>
                {when(today.nextPublication.scheduledAt, today.nextPublication.timezone)}
              </p>
            </div>
            <PlatformTag platform={today.nextPublication.platform} />
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <Stat label="ждут решения" value={today?.pendingApprovals ?? 0} href="/pulse/approvals" />
          <Stat label="ошибки очереди" value={today?.failedJobs ?? 0} href="/pulse/calendar" alarm />
          <Stat label="вчера вышло" value={today?.yesterday.published ?? 0} href="/pulse/analytics" />
        </div>
        {today?.yesterday.views ? (
          <p className="mono dim" style={{ marginTop: 14 }}>
            Просмотров за вчера: {today.yesterday.views}
          </p>
        ) : null}
      </section>

      <section className="section">
        <p className="label" style={{ marginBottom: 12 }}>Быстро</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Link className="btn btn-small" href="/pulse/ideas">Добавить идею</Link>
          <Link className="btn btn-small" href="/pulse/connections">Подключения</Link>
          <Link className="btn btn-small" href="/pulse/projects">Пространства</Link>
        </div>
        {!session.aiConnected ? (
          <p className="mono dim" style={{ marginTop: 16 }}>
            Модель не подключена: версии собираются как раскладка идеи по формату.
            Задай ANTHROPIC_API_KEY, чтобы включить генерацию.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  alarm,
}: {
  label: string;
  value: number;
  href: string;
  alarm?: boolean;
}) {
  return (
    <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>
      <div
        className="display"
        style={{ fontSize: 40, color: alarm && value > 0 ? 'var(--accent)' : undefined }}
      >
        {value}
      </div>
      <div className="label">{label}</div>
    </Link>
  );
}

/** Первый запуск: пространство, проект, первая идея. Цель — 7 минут. */
function FirstRun({ hasWorkspace }: { hasWorkspace: boolean }) {
  const { session, reload, setProjectId } = usePulse();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const create = async () => {
    setBusy(true);
    setFailure(null);
    try {
      if (!hasWorkspace) {
        const workspace = await api.post<{ id: string }>('/api/pulse/workspaces', {
          name,
          type: 'personal',
        });
        const project = await api.post<{ id: string }>('/api/pulse/projects', {
          workspaceId: workspace.id,
          name,
        });
        setProjectId(project.id);
      } else {
        const workspaceId = session?.workspaces[0]?.id;
        const project = await api.post<{ id: string }>('/api/pulse/projects', {
          workspaceId,
          name,
        });
        setProjectId(project.id);
      }
      await reload();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.post('/api/pulse/workspaces/join', { code });
      await reload();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="display">PULSE</h1>
        <p className="dim" style={{ marginTop: 12, maxWidth: 460 }}>
          Одна идея превращается в согласованный пакет публикаций для всех нужных площадок
          за несколько минут. Последнее решение всегда остаётся за человеком.
        </p>
      </header>

      <section className="section stack">
        <p className="label">{hasWorkspace ? 'Новый проект' : 'Рабочее пространство'}</p>
        <input
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={hasWorkspace ? 'Название проекта' : 'SEZGI, MYRA, имя клиента…'}
          maxLength={60}
        />
        <button className="btn btn-main" disabled={busy || name.trim().length < 2} onClick={() => void create()}>
          {hasWorkspace ? 'Создать проект' : 'Создать пространство'}
        </button>
        <Err text={failure} />
      </section>

      {!hasWorkspace ? (
        <section className="section stack">
          <p className="label">Или войти по коду</p>
          <div className="row">
            <input
              className="field grow"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))}
              placeholder="Код приглашения"
              autoCapitalize="characters"
              spellCheck={false}
            />
            <button className="btn" disabled={busy || code.length !== 8} onClick={() => void join()}>
              Войти
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
