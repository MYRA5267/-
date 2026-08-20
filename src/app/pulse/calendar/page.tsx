'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../_ui/api';
import { usePulse } from '../_ui/PulseProvider';
import { Err, Loading, PlatformTag, ProjectSwitch, Status, toLocalInput, when } from '../_ui/bits';
import { isErrorStatus } from '@/lib/pulse/status';
import type { Schedule } from '@/lib/pulse/types';

/**
 * Календарь и очередь.
 *
 * День за днём: что уйдёт, что уже ушло и что сломалось. Перенос —
 * изменением времени; отмена возможна, пока задача не забрана в работу.
 */
export default function CalendarPage() {
  const { projectId, project, loading } = usePulse();
  const [items, setItems] = useState<Schedule[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setItems(await api.get<Schedule[]>(`/api/pulse/schedules?project=${projectId}`));
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const move = async (id: string, local: string) => {
    setBusy(id);
    setFailure(null);
    try {
      await api.patch(`/api/pulse/schedules/${id}`, {
        scheduledAt: new Date(local).toISOString(),
      });
      await load();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string) => {
    setBusy(id);
    setFailure(null);
    try {
      await api.del(`/api/pulse/schedules/${id}`);
      await load();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (!projectId) return <div className="empty">Сначала создай проект</div>;

  const days = groupByDay(items, project?.timezone);

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="h2">Очередь</h1>
        <p className="mono dim" style={{ marginTop: 8 }}>
          время в поясе проекта: {project?.timezone ?? 'UTC'}
        </p>
        <div style={{ marginTop: 14 }}>
          <ProjectSwitch />
        </div>
      </header>

      <section className="section stack">
        <Err text={failure} />
        {items.length === 0 ? (
          <div className="empty">Очередь пуста. Одобренный материал ставится из редактора.</div>
        ) : (
          days.map(([day, list]) => (
            <div key={day}>
              <p className="label" style={{ marginTop: 12 }}>{day}</p>
              {list.map((item) => (
                <div className="card-flat" key={item.id}>
                  <div className="row-between">
                    <span className="grow" style={{ fontWeight: 500 }}>{item.title}</span>
                    <PlatformTag platform={item.platform} />
                  </div>
                  <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                    <Status status={item.status} />
                    <span className="mono dim">{when(item.scheduledAt, item.timezone)}</span>
                  </div>

                  {isErrorStatus(item.status) && item.errorMessage ? (
                    <p className="err" style={{ marginTop: 10 }}>{item.errorMessage}</p>
                  ) : null}

                  {item.externalUrl ? (
                    <a
                      className="mono accent"
                      href={item.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'inline-block', marginTop: 10 }}
                    >
                      открыть публикацию →
                    </a>
                  ) : null}

                  {item.status === 'SCHEDULED' ? (
                    <div className="row" style={{ marginTop: 12 }}>
                      <input
                        className="field grow"
                        type="datetime-local"
                        defaultValue={toLocalInput(new Date(item.scheduledAt))}
                        onBlur={(e) => void move(item.id, e.target.value)}
                      />
                      <button
                        className="btn btn-small btn-danger"
                        disabled={busy === item.id}
                        onClick={() => void cancel(item.id)}
                      >
                        Снять
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function groupByDay(items: Schedule[], timezone?: string): Array<[string, Schedule[]]> {
  const map = new Map<string, Schedule[]>();
  for (const item of items) {
    const day = new Intl.DateTimeFormat('ru-RU', {
      weekday: 'short',
      day: '2-digit',
      month: 'long',
      timeZone: timezone,
    }).format(new Date(item.scheduledAt));
    const list = map.get(day) ?? [];
    list.push(item);
    map.set(day, list);
  }
  return [...map.entries()];
}
