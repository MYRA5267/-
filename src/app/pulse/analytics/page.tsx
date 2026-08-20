'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../_ui/api';
import { usePulse } from '../_ui/PulseProvider';
import { Err, Loading, PlatformTag, ProjectSwitch, when } from '../_ui/bits';
import type { AnalyticsDigest, ScoredPublication } from '@/lib/pulse/ai/copilot';
import type { MetricInput, PublicationRow } from '@/lib/pulse/types';

/**
 * Аналитика.
 *
 * Первый экран отвечает не на вопрос «сколько цифр мы собрали», а на
 * вопрос «что делать дальше». Метрики, которых площадка не отдаёт,
 * вводятся руками — и это видно.
 */

type Response = AnalyticsDigest & { projectName: string; publications: PublicationRow[] };

const FIELDS: Array<[keyof MetricInput, string]> = [
  ['views', 'просмотры'],
  ['reach', 'охват'],
  ['likes', 'лайки'],
  ['replies', 'комментарии'],
  ['reposts', 'пересылки'],
  ['saves', 'сохранения'],
  ['profileVisits', 'заходы в профиль'],
  ['linkClicks', 'переходы'],
];

const BAND: Record<ScoredPublication['band'], string> = {
  top: 'верх 20%',
  middle: 'середина',
  bottom: 'низ 20%',
};

export default function AnalyticsPage() {
  const { projectId, loading } = usePulse();
  const [data, setData] = useState<Response | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [explained, setExplained] = useState(false);

  const load = useCallback(
    async (explain = false) => {
      if (!projectId) return;
      try {
        setData(
          await api.get<Response>(
            `/api/pulse/analytics/${projectId}${explain ? '?explain=1' : ''}`,
          ),
        );
      } catch (e) {
        setFailure(errorText(e));
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const saveMetrics = async (publicationId: string) => {
    setBusy(publicationId);
    setFailure(null);
    try {
      const payload: Record<string, number> = {};
      for (const [key] of FIELDS) {
        const raw = draft[`${publicationId}:${key}`];
        if (raw && Number.isFinite(Number(raw))) payload[key] = Number(raw);
      }
      await api.post(`/api/pulse/analytics/publications/${publicationId}/metrics`, payload);
      setOpen(null);
      await load(explained);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const acceptHypothesis = async () => {
    if (!data?.nextHypothesis || !projectId) return;
    setBusy('hypothesis');
    try {
      await api.post('/api/pulse/analytics/hypothesis', {
        projectId,
        text: data.nextHypothesis,
      });
      setFailure(null);
      alert('Гипотеза в банке идей');
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (!projectId) return <div className="empty">Сначала создай проект</div>;

  const scoreById = new Map(data?.scored.map((s) => [s.id, s]) ?? []);

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="h2">Что делать дальше</h1>
        <div style={{ marginTop: 14 }}>
          <ProjectSwitch />
        </div>
      </header>

      <section className="section stack">
        <p className="preview">{data?.summary ?? 'Считаем…'}</p>

        {data?.nextHypothesis ? (
          <div className="card">
            <p className="label cold">следующая гипотеза</p>
            <p style={{ margin: '8px 0 12px' }}>{data.nextHypothesis}</p>
            <button
              className="btn btn-small"
              disabled={busy === 'hypothesis'}
              onClick={() => void acceptHypothesis()}
            >
              В банк идей
            </button>
          </div>
        ) : null}

        {!explained && data && data.scored.length > 0 ? (
          <button
            className="btn"
            onClick={() => {
              setExplained(true);
              void load(true);
            }}
          >
            Объяснить словами
          </button>
        ) : null}

        <Err text={failure} />
      </section>

      <section className="section">
        <p className="label" style={{ marginBottom: 12 }}>Публикации</p>

        {!data || data.publications.length === 0 ? (
          <div className="empty">Публикаций ещё не было.</div>
        ) : (
          data.publications.map((pub) => {
            const scored = scoreById.get(pub.id);
            return (
              <div className="card-flat" key={pub.id}>
                <div className="row-between">
                  <span className="grow" style={{ fontWeight: 500 }}>{pub.title}</span>
                  <PlatformTag platform={pub.platform} />
                </div>

                <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  <span className="mono dim">{when(pub.publishedAt)}</span>
                  {scored ? (
                    <span className={`tag ${scored.band === 'top' ? 'tag-ok' : scored.band === 'bottom' ? 'tag-warn' : 'tag-cold'}`}>
                      {BAND[scored.band]} · {scored.score}
                    </span>
                  ) : (
                    <span className="tag">без метрик</span>
                  )}
                </div>

                {scored ? (
                  <p className="mono cold" style={{ marginTop: 8 }}>{scored.verdict}</p>
                ) : null}

                {pub.externalUrl ? (
                  <a
                    className="mono dim"
                    href={pub.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: 'inline-block', marginTop: 8 }}
                  >
                    открыть →
                  </a>
                ) : null}

                {open === pub.id ? (
                  <div className="stack" style={{ marginTop: 12 }}>
                    {FIELDS.map(([key, label]) => (
                      <div className="row" key={key}>
                        <label className="mono dim grow" htmlFor={`${pub.id}-${key}`}>{label}</label>
                        <input
                          id={`${pub.id}-${key}`}
                          className="field"
                          style={{ width: 120 }}
                          inputMode="numeric"
                          defaultValue={pub.metrics?.[key] ?? ''}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [`${pub.id}:${key}`]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                    <button
                      className="btn btn-main"
                      disabled={busy === pub.id}
                      onClick={() => void saveMetrics(pub.id)}
                    >
                      Сохранить результаты
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-small"
                    style={{ marginTop: 10 }}
                    onClick={() => setOpen(pub.id)}
                  >
                    {pub.metrics ? 'Обновить метрики' : 'Ввести метрики'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
