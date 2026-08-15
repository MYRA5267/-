'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../_ui/api';
import { usePulse } from '../_ui/PulseProvider';
import { Err, Loading, PlatformTag, ProjectSwitch, when } from '../_ui/bits';
import type { Approval } from '@/lib/pulse/types';

/**
 * Согласования.
 *
 * Одобряется конкретный снимок текста. Если материал успели поправить,
 * карточка перестаёт быть актуальной — и сервер об этом честно скажет,
 * а не опубликует не то, что человек видел.
 */
export default function ApprovalsPage() {
  const { projectId, loading, refreshPending } = usePulse();
  const [items, setItems] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [diff, setDiff] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setItems(await api.get<Approval[]>(`/api/pulse/approvals?project=${projectId}`));
      await refreshPending();
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [projectId, refreshPending]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, action: 'approve' | 'reject') => {
    setBusy(id);
    setFailure(null);
    try {
      await api.post(`/api/pulse/approvals/${id}/${action}`, { comment: comment[id] ?? '' });
      await load();
    } catch (e) {
      setFailure(errorText(e));
      // список перечитываем в любом случае: карточка могла устареть
      await load();
    } finally {
      setBusy(null);
    }
  };

  /** «Одобрить всё» по пакету: одно нажатие вместо четырёх. */
  const approvePack = async (contentItemId: string) => {
    setBusy(contentItemId);
    setFailure(null);
    try {
      const result = await api.post<{ approved: number; skipped: number }>(
        `/api/pulse/approvals/${contentItemId}/approve`,
        { all: true },
      );
      if (result.skipped) {
        setFailure(
          `Одобрено ${result.approved}, пропущено ${result.skipped}: текст успели поправить.`,
        );
      }
      await load();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  // карточки одного материала показываем вместе — решение принимают по пакету
  const packs = useMemo(() => {
    const map = new Map<string, Approval[]>();
    for (const item of items) {
      const key = item.contentItemId ?? item.id;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [items]);

  if (loading) return <Loading />;
  if (!projectId) return <div className="empty">Сначала создай проект</div>;

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="h2">Ждут решения</h1>
        <div style={{ marginTop: 14 }}>
          <ProjectSwitch />
        </div>
      </header>

      <section className="section stack">
        <Err text={failure} />

        {packs.length === 0 ? (
          <div className="empty">Ничего не ждёт. Это хорошая новость.</div>
        ) : (
          packs.map(([contentItemId, group]) => (
            <div className="stack" key={contentItemId}>
              {group.length > 1 ? (
                <div className="row-between">
                  <span className="label">пакет из {group.length} версий</span>
                  <button
                    className="btn btn-small"
                    disabled={busy !== null}
                    onClick={() => void approvePack(contentItemId)}
                  >
                    Одобрить всё
                  </button>
                </div>
              ) : null}

              {group.map((item) => (
                <div className="card" key={item.id}>
                  <div className="row-between">
                    {item.preview ? <PlatformTag platform={item.preview.platform} /> : <span />}
                    <span className="mono dim">{when(item.createdAt)}</span>
                  </div>

                  {item.preview ? (
                    <div style={{ marginTop: 12 }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>{item.preview.firstHook}</p>
                      <p className="preview dim" style={{ marginTop: 8 }}>
                        {item.preview.body.slice(0, 600)}
                        {item.preview.body.length > 600 ? '…' : ''}
                      </p>

                      {item.preview.previousBody ? (
                        <>
                          <button
                            className="btn btn-small"
                            style={{ marginTop: 10 }}
                            onClick={() =>
                              setDiff((d) => ({ ...d, [item.id]: !d[item.id] }))
                            }
                          >
                            {diff[item.id] ? 'Скрыть прошлую редакцию' : 'Что изменилось'}
                          </button>
                          {diff[item.id] ? (
                            <div className="card" style={{ marginTop: 10 }}>
                              <p className="label">было</p>
                              <p className="preview dim" style={{ marginTop: 8 }}>
                                {item.preview.previousBody.slice(0, 600)}
                                {item.preview.previousBody.length > 600 ? '…' : ''}
                              </p>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  <input
                    className="field"
                    style={{ marginTop: 14 }}
                    placeholder="Комментарий (нужен при возврате)"
                    value={comment[item.id] ?? ''}
                    onChange={(e) => setComment((c) => ({ ...c, [item.id]: e.target.value }))}
                  />

                  <div className="row" style={{ marginTop: 12 }}>
                    <button
                      className="btn btn-main"
                      style={{ width: 'auto', flex: 1 }}
                      disabled={busy !== null}
                      onClick={() => void decide(item.id, 'approve')}
                    >
                      Одобрить
                    </button>
                    <button
                      className="btn btn-danger"
                      disabled={busy !== null || !(comment[item.id] ?? '').trim()}
                      onClick={() => void decide(item.id, 'reject')}
                    >
                      Вернуть
                    </button>
                  </div>

                  {item.contentItemId ? (
                    <Link
                      className="mono dim"
                      style={{ display: 'inline-block', marginTop: 12 }}
                      href={`/pulse/editor/${item.contentItemId}`}
                    >
                      открыть в редакторе →
                    </Link>
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
