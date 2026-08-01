'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PairState } from '@/lib/types';

const ERRORS: Record<string, string> = {
  INVALID_CODE: 'Такого кода нет',
  COUPLE_FULL: 'В той паре уже двое',
  ALREADY_PAIRED: 'Ты уже в паре',
  OWN_CODE: 'Это твой собственный код',
  DB_NOT_CONFIGURED: 'База не подключена — заполни DATABASE_URL',
  UNAUTHORIZED: 'Telegram не подтвердил вход',
  SERVER_ERROR: 'Сервер не ответил',
};

/** Сырой initData: только внутри Telegram, только на клиенте. */
async function rawInitData(): Promise<string | undefined> {
  try {
    const sdk = await import('@telegram-apps/sdk-react');
    if (!sdk.isTMA()) return undefined;
    sdk.init();
    return sdk.retrieveRawInitData();
  } catch {
    return undefined;
  }
}

export default function PairGate() {
  const [state, setState] = useState<PairState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [code, setCode] = useState('');
  const initData = useRef<string | undefined>(undefined);

  const call = useCallback(async (url: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (initData.current) headers['x-telegram-init-data'] = initData.current;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({ error: 'SERVER_ERROR' }));
    if (!res.ok) throw new Error(json.error ?? 'SERVER_ERROR');
    return json as PairState;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      initData.current = await rawInitData();
      try {
        const next = await call('/api/auth/session');
        if (alive) setState(next);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [call]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await call('/api/pair/join', { code }));
      setCode('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (busy && !state) {
    return <div className="empty">Проявляется…</div>;
  }

  return (
    <>
      {error && <div className="pair-err">{ERRORS[error] ?? error}</div>}

      {state && state.partner && (
        <div className="pair">
          <div className="pair-label">пара собрана</div>
          <div className="pair-people">
            <span className={`who ${state.me.ink === 'blue' ? 'g' : 'm'}`}>
              {state.me.displayName}
            </span>
            <span className={`who ${state.partner.ink === 'blue' ? 'g' : 'm'}`}>
              {state.partner.displayName}
            </span>
            <span className="who both">Оба</span>
          </div>
          <p className="pair-note">
            Связка закрыта навсегда — третьего в паре быть не может. Дальше экран «Сегодня».
          </p>
        </div>
      )}

      {state && !state.partner && (
        <>
          <div className="pair">
            <div className="pair-label">код для второго</div>
            <div className="pair-code">{state.couple.inviteCode}</div>
            <p className="pair-note">
              Отдай этот код. Он вводит его у себя — и всё, вы вдвоём в одном пространстве.
            </p>
          </div>

          <div className="capture">
            <div className="capture-row">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && code.length === 6 && !busy) void join();
                }}
                placeholder="Или введи его код…"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
              />
              <button
                onClick={() => void join()}
                disabled={busy || code.length !== 6}
                aria-label="Связать"
              >
                +
              </button>
            </div>
            <div className="capture-foot">
              <span>шесть символов · связка навсегда</span>
            </div>
          </div>
        </>
      )}

      {!state && !error && <div className="empty">Открой приложение внутри Telegram</div>}

      <div className="footbar">
        <span>
          Приводка <b>{state?.partner ? 'пара на месте' : 'ждём второго'}</b>
        </span>
        <span>{state ? `слой: ${state.me.ink === 'blue' ? 'синий' : 'розовый'}` : '—'}</span>
      </div>
    </>
  );
}
