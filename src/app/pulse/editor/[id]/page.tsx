'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, errorText, ensureInitData } from '../../_ui/api';
import { usePulse } from '../../_ui/PulseProvider';
import { Err, Findings, Loading, Status, toLocalInput } from '../../_ui/bits';
import { PLATFORM_SPECS, REWRITE_ACTIONS, type RewriteAction } from '@/lib/pulse/ai/prompts';
import {
  AUTO_PUBLISH,
  PLATFORMS,
  type ContentPack,
  type Platform,
  type Schedule,
  type Variant,
} from '@/lib/pulse/types';
import type { QualityFinding } from '@/lib/pulse/ai/quality';

/**
 * AI-редактор.
 *
 * Исходная идея, платформенные вкладки, правка, проверка качества,
 * одобрение и постановка в календарь. Ничего не уходит на площадку,
 * пока человек не одобрил конкретный снимок текста.
 */

const ACTION_LABEL: Record<RewriteAction, string> = {
  hook: 'Усилить хук',
  alive: 'Сделать живее',
  shorten: 'Сжать',
  concrete: 'Добавить конкретику',
  human: 'Убрать ИИ-тон',
};

export default function EditorPage() {
  const params = useParams<{ id: string }>();
  const contentId = params.id;
  const { project, session, refreshPending } = usePulse();

  const [pack, setPack] = useState<ContentPack | null>(null);
  const [active, setActive] = useState<Platform | null>(null);
  const [findings, setFindings] = useState<QualityFinding[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Platform[]>(['telegram', 'threads', 'instagram']);
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000)));
  const [conflicts, setConflicts] = useState<Schedule[]>([]);

  const load = useCallback(async () => {
    try {
      const next = await api.get<ContentPack>(`/api/pulse/content/${contentId}`);
      setPack(next);
      setActive((current) => current ?? next.variants[0]?.platform ?? null);
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [contentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const variant = useMemo(
    () => pack?.variants.find((v) => v.platform === active) ?? null,
    [pack, active],
  );

  useEffect(() => {
    if (!variant) return;
    let alive = true;
    void api
      .get<{ findings: QualityFinding[] }>(`/api/pulse/variants/${variant.id}/inspect`)
      .then((r) => {
        if (alive) setFindings(r.findings);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [variant?.id, variant?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // что уже стоит рядом — показываем до нажатия, а не после
  useEffect(() => {
    const projectId = pack?.item.projectId;
    if (!projectId || !variant || variant.status !== 'APPROVED') {
      setConflicts([]);
      return;
    }
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return;

    let alive = true;
    void api
      .get<Schedule[]>(
        `/api/pulse/schedules/conflicts?project=${projectId}&at=${when.toISOString()}`,
      )
      .then((found) => {
        if (alive) setConflicts(found);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [at, pack?.item.projectId, variant?.id, variant?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setFailure(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    run('generate', async () => {
      const result = await api.post<{ producedBy: string; hypothesis: string }>(
        `/api/pulse/ideas/${contentId}/generate`,
        { platforms: chosen },
      );
      setNote(
        result.producedBy === 'offline'
          ? 'Собрано без модели: это раскладка идеи по формату, а не готовый текст.'
          : `Собрано моделью ${result.producedBy}.` +
              (result.hypothesis ? ` Гипотеза: ${result.hypothesis}` : ''),
      );
      await load();
    });

  const save = (patch: Partial<Pick<Variant, 'body' | 'firstHook' | 'cta'>>) =>
    run('save', async () => {
      if (!variant) return;
      const result = await api.patch<{ variant: Variant; findings: QualityFinding[] }>(
        `/api/pulse/variants/${variant.id}`,
        patch,
      );
      setFindings(result.findings);
      await load();
    });

  const rewrite = (action: RewriteAction) =>
    run(action, async () => {
      if (!variant) return;
      const result = await api.post<{ findings: QualityFinding[]; producedBy: string }>(
        `/api/pulse/variants/${variant.id}/rewrite`,
        { action },
      );
      setFindings(result.findings);
      setNote(`Правка от ${result.producedBy}. Проверь и одобри, если согласен.`);
      await load();
    });

  const requestApproval = () =>
    run('approve', async () => {
      if (!variant) return;
      await api.post('/api/pulse/approvals/request', { variantId: variant.id });
      setNote('Отправлено на согласование.');
      await Promise.all([load(), refreshPending()]);
    });

  const schedule = () =>
    run('schedule', async () => {
      if (!variant) return;
      await api.post('/api/pulse/schedules', {
        variantId: variant.id,
        scheduledAt: new Date(at).toISOString(),
      });
      setNote('В календаре. Отправим в указанное время.');
      await load();
    });

  const download = async () => {
    // экспорт отдаётся файлом, поэтому идём мимо json-обёртки
    setFailure(null);
    try {
      const initData = await ensureInitData();
      const response = await fetch(`/api/pulse/content/${contentId}/export`, {
        headers: initData ? { 'x-telegram-init-data': initData } : {},
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        setFailure('Экспорт не собрался');
        return;
      }

      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `pulse-${contentId.slice(0, 8)}.txt`;
      // якорь должен быть в документе, иначе часть браузеров молча не скачает,
      // а ссылку освобождаем не в том же такте — иначе отменим собственную загрузку
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setFailure('Экспорт не собрался');
    }
  };

  if (!pack) {
    // без этого любая ошибка загрузки выглядит как бесконечная загрузка
    return failure ? (
      <div className="wrap section">
        <Err text={failure} />
      </div>
    ) : (
      <Loading />
    );
  }

  const spec = variant ? PLATFORM_SPECS[variant.platform] : null;
  const length = variant ? `${variant.firstHook}\n\n${variant.body}`.trim().length : 0;

  return (
    <div className="wrap">
      <header className="section">
        <p className="label">{project?.name ?? 'Проект'}</p>
        <h1 className="h2" style={{ marginTop: 8 }}>
          {pack.item.title || 'Без названия'}
        </h1>
        <p className="dim" style={{ marginTop: 10, fontSize: 14 }}>
          {pack.item.sourceText}
        </p>
      </header>

      {pack.variants.length === 0 ? (
        <section className="section stack">
          <p className="label">Площадки</p>
          <div className="chips">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                className="chip"
                aria-pressed={chosen.includes(p)}
                onClick={() =>
                  setChosen((current) =>
                    current.includes(p) ? current.filter((x) => x !== p) : [...current, p],
                  )
                }
              >
                {PLATFORM_SPECS[p].label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-main"
            disabled={busy === 'generate' || chosen.length === 0}
            onClick={() => void generate()}
          >
            {busy === 'generate' ? 'Собираем версии…' : 'Собрать пакет'}
          </button>
          {!session?.aiConnected ? (
            <p className="mono dim">
              Модель не подключена — версии соберутся как раскладка идеи по формату.
            </p>
          ) : null}
          <Err text={failure} />
        </section>
      ) : null}

      {pack.variants.length > 0 && variant && spec ? (
        <>
          <div className="tabs">
            {pack.variants.map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={v.platform === active}
                onClick={() => setActive(v.platform)}
              >
                {PLATFORM_SPECS[v.platform].label}
              </button>
            ))}
          </div>

          <section className="section stack">
            <div className="row-between">
              <Status status={variant.status} />
              <span className="mono dim">
                {length}/{spec.softLimit} · v{variant.version}
                {AUTO_PUBLISH[variant.platform] ? '' : ' · экспорт'}
              </span>
            </div>

            <label className="label" htmlFor="hook">Первая строка</label>
            <textarea
              id="hook"
              className="field"
              rows={2}
              defaultValue={variant.firstHook}
              key={`hook-${variant.id}-${variant.version}`}
              onBlur={(e) =>
                e.target.value !== variant.firstHook && void save({ firstHook: e.target.value })
              }
            />

            <label className="label" htmlFor="body">Текст</label>
            <textarea
              id="body"
              className="field"
              rows={12}
              defaultValue={variant.body}
              key={`body-${variant.id}-${variant.version}`}
              onBlur={(e) => e.target.value !== variant.body && void save({ body: e.target.value })}
            />

            <label className="label" htmlFor="cta">Призыв</label>
            <input
              id="cta"
              className="field"
              defaultValue={variant.cta}
              key={`cta-${variant.id}-${variant.version}`}
              onBlur={(e) => e.target.value !== variant.cta && void save({ cta: e.target.value })}
            />

            <div className="row" style={{ flexWrap: 'wrap' }}>
              {(Object.keys(REWRITE_ACTIONS) as RewriteAction[]).map((action) => (
                <button
                  key={action}
                  className="btn btn-small"
                  disabled={busy !== null}
                  onClick={() => void rewrite(action)}
                >
                  {busy === action ? '…' : ACTION_LABEL[action]}
                </button>
              ))}
            </div>

            {note ? <p className="mono dim">{note}</p> : null}
            <Err text={failure} />
          </section>

          <section className="section">
            <p className="label" style={{ marginBottom: 10 }}>Проверка перед отправкой</p>
            <Findings findings={findings} />
          </section>

          <section className="section stack">
            {variant.status === 'APPROVED' ? (
              <>
                <p className="label">Когда публикуем</p>
                <input
                  className="field"
                  type="datetime-local"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                />
                {conflicts.length ? (
                  <p className="mono warn-note">
                    Рядом уже стоит:{' '}
                    {conflicts
                      .map((c) => `${PLATFORM_SPECS[c.platform].label} · ${c.title}`)
                      .join('; ')}
                  </p>
                ) : null}
                <button
                  className="btn btn-main"
                  disabled={busy !== null || !AUTO_PUBLISH[variant.platform]}
                  onClick={() => void schedule()}
                >
                  Поставить в очередь
                </button>
                {!AUTO_PUBLISH[variant.platform] ? (
                  <p className="mono dim">
                    {PLATFORM_SPECS[variant.platform].label} публикуется вручную: скачай пакет
                    и загрузи его на площадке.
                  </p>
                ) : null}
              </>
            ) : (
              <button
                className="btn btn-main"
                disabled={busy !== null || variant.status === 'IN_REVIEW'}
                onClick={() => void requestApproval()}
              >
                {variant.status === 'IN_REVIEW' ? 'Ждёт решения' : 'Отправить на одобрение'}
              </button>
            )}

            <button className="btn" onClick={() => void download()}>
              Скачать пакет для ручной загрузки
            </button>
          </section>
        </>
      ) : null}
    </div>
  );
}
