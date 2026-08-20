'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../_ui/api';
import { usePulse } from '../_ui/PulseProvider';
import { Err, Loading, ProjectSwitch, when } from '../_ui/bits';
import { PLATFORM_SPECS } from '@/lib/pulse/ai/prompts';
import { AUTO_PUBLISH, PLATFORMS, type Platform, type SocialAccount } from '@/lib/pulse/types';

/**
 * Подключения.
 *
 * Пароли соцсетей не запрашиваются и не хранятся. Telegram публикует
 * бот — ему достаточно быть админом канала. Остальные площадки в MVP
 * готовят материал и отдают пакет для ручной загрузки.
 */
export default function ConnectionsPage() {
  const { projectId, loading } = usePulse();
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [platform, setPlatform] = useState<Platform>('telegram');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      setAccounts(await api.get<SocialAccount[]>(`/api/pulse/projects/${projectId}/connections`));
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy('connect');
    setFailure(null);
    setNote(null);
    try {
      await api.post(`/api/pulse/projects/${projectId}/connections`, {
        platform,
        externalAccountId: handle.trim(),
        displayName: handle.trim(),
      });
      setHandle('');
      await load();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async (id: string) => {
    setBusy(id);
    setFailure(null);
    try {
      const result = await api.post<{ ok: boolean; message: string }>(
        `/api/pulse/connections/${id}/test`,
      );
      setNote(result.message);
      await load();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api.del(`/api/pulse/connections/${id}`);
      await load();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (!projectId) return <div className="empty">Сначала создай проект</div>;

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="h2">Подключения</h1>
        <div style={{ marginTop: 14 }}>
          <ProjectSwitch />
        </div>
      </header>

      <section className="section stack">
        <div className="chips">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              className="chip"
              aria-pressed={p === platform}
              onClick={() => setPlatform(p)}
            >
              {PLATFORM_SPECS[p].label}
            </button>
          ))}
        </div>

        <input
          className="field"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder={
            platform === 'telegram' ? '@канал или -100…' : 'имя аккаунта на площадке'
          }
          spellCheck={false}
        />

        <button
          className="btn btn-main"
          disabled={busy === 'connect' || handle.trim().length < 2}
          onClick={() => void connect()}
        >
          Подключить
        </button>

        <p className="mono dim">
          {AUTO_PUBLISH[platform]
            ? 'Бот должен быть администратором канала с правом публикации.'
            : 'Публикуется вручную: PULSE соберёт пакет и напомнит.'}
        </p>
        {note ? <p className="mono cold">{note}</p> : null}
        <Err text={failure} />
      </section>

      <section className="section">
        <p className="label" style={{ marginBottom: 12 }}>Подключено</p>
        {accounts.length === 0 ? (
          <div className="empty">Пока ничего.</div>
        ) : (
          accounts.map((account) => (
            <div className="card-flat" key={account.id}>
              <div className="row-between">
                <span className="grow" style={{ fontWeight: 500 }}>
                  {PLATFORM_SPECS[account.platform].label} · {account.externalAccountId}
                </span>
                <span className={`tag ${account.status === 'connected' ? 'tag-ok' : account.status === 'auth_required' ? 'tag-warn' : ''}`}>
                  {label(account.status)}
                </span>
              </div>
              <p className="mono dim" style={{ margin: '8px 0 0' }}>
                {account.lastSyncedAt ? `проверено ${when(account.lastSyncedAt)}` : 'ещё не проверяли'}
              </p>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn btn-small"
                  disabled={busy === account.id}
                  onClick={() => void test(account.id)}
                >
                  Проверить доступ
                </button>
                <button
                  className="btn btn-small btn-danger"
                  disabled={busy === account.id}
                  onClick={() => void remove(account.id)}
                >
                  Отключить
                </button>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function label(status: SocialAccount['status']): string {
  return status === 'connected'
    ? 'публикуем'
    : status === 'auth_required'
      ? 'нужен доступ'
      : status === 'export_only'
        ? 'экспорт'
        : 'выключен';
}
