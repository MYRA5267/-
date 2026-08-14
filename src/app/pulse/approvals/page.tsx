'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
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
  const { projectId, loading } = usePulse();
  const [items, setItems] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [comment, setComment] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setItems(await api.get<Approval[]>(`/api/pulse/approvals?project=${projectId}`));
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, action: 'approve' | 'reject') => {
    setBusy(id);
    setFailure(null);
    try {
      await api.post(`/api/pulse/approvals/${id}/${action}`, {
        comment: comment[id] ?? '',
      });
      await load();
    } catch (e) {
      setFailure(errorText(e));
      await load();
    } finally {
      setBusy(null);
    }
  };

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
        {items.length === 0 ? (
          <div className="empty">Ничего не ждёт. Это хорошая новость.</div>
        ) : (
          items.map((item) => (
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
                  disabled={busy === item.id}
                  onClick={() => void decide(item.id, 'approve')}
                >
                  Одобрить
                </button>
                <button
                  className="btn btn-danger"
                  disabled={busy === item.id || !(comment[item.id] ?? '').trim()}
                  onClick={() => void decide(item.id, 'reject')}
                >
                  Вернуть
                </button>
              </div>

              <Link
                className="mono dim"
                style={{ display: 'inline-block', marginTop: 12 }}
                href={`/pulse/editor/${item.targetId}`}
              >
                открыть в редакторе →
              </Link>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
