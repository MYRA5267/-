'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../_ui/api';
import { usePulse } from '../_ui/PulseProvider';
import { Err, Loading, ProjectSwitch, Status, when } from '../_ui/bits';
import { OBJECTIVE_LABEL, type Idea, type IdeaState, type Objective } from '@/lib/pulse/types';

/**
 * Банк идей.
 *
 * Вход текстом, ссылкой или пересланным сообщением. Голос и медиа
 * добавляются следующим шагом — сейчас честно показываем, что есть.
 */

const FILTERS: Array<[IdeaState | 'all', string]> = [
  ['all', 'все'],
  ['new', 'новые'],
  ['in_progress', 'в работе'],
  ['used', 'использованы'],
  ['research', 'исследовать'],
  ['later', 'на потом'],
];

const OBJECTIVES = Object.keys(OBJECTIVE_LABEL) as Objective[];

export default function IdeasPage() {
  const { projectId, loading } = usePulse();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [filter, setFilter] = useState<IdeaState | 'all'>('all');
  const [text, setText] = useState('');
  const [objective, setObjective] = useState<Objective>('reach');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    const query = filter === 'all' ? '' : `&state=${filter}`;
    try {
      setIdeas(await api.get<Idea[]>(`/api/pulse/ideas?project=${projectId}${query}`));
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [projectId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.post('/api/pulse/ideas', { projectId, sourceText: text, objective });
      setText('');
      await load();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading />;
  if (!projectId) return <div className="empty">Сначала создай проект</div>;

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="h2">Банк идей</h1>
        <div style={{ marginTop: 14 }}>
          <ProjectSwitch />
        </div>
      </header>

      <section className="section stack">
        <textarea
          className="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Что пришло в голову? Одна мысль, своими словами."
          rows={4}
        />
        <div className="chips">
          {OBJECTIVES.map((o) => (
            <button
              key={o}
              className="chip"
              aria-pressed={o === objective}
              onClick={() => setObjective(o)}
            >
              {OBJECTIVE_LABEL[o]}
            </button>
          ))}
        </div>
        <button
          className="btn btn-main"
          disabled={busy || text.trim().length < 5}
          onClick={() => void add()}
        >
          Сохранить идею
        </button>
        <Err text={failure} />
      </section>

      <section className="section">
        <div className="chips" style={{ marginBottom: 8 }}>
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              className="chip"
              aria-pressed={value === filter}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {ideas.length === 0 ? (
          <div className="empty">Пусто. Первая идея — сверху.</div>
        ) : (
          ideas.map((idea) => (
            <Link
              key={idea.id}
              href={`/pulse/editor/${idea.id}`}
              className="card-flat"
              style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
            >
              <div className="row-between">
                <span className="grow" style={{ fontWeight: 500 }}>
                  {idea.title || idea.sourceText.slice(0, 60)}
                </span>
                <Status status={idea.status} />
              </div>
              <p className="dim" style={{ margin: '6px 0 0', fontSize: 14 }}>
                {idea.sourceText.slice(0, 140)}
                {idea.sourceText.length > 140 ? '…' : ''}
              </p>
              <p className="mono dim" style={{ margin: '8px 0 0' }}>
                {when(idea.createdAt)} · версий: {idea.variantCount} · цель:{' '}
                {OBJECTIVE_LABEL[idea.objective]}
              </p>
            </Link>
          ))
        )}
      </section>
    </div>
  );
}
