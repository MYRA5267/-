'use client';

import { useState } from 'react';
import type { AppState } from '@/lib/types';

const ERRORS: Record<string, string> = {
  INVALID_CODE: 'Такого кода нет',
  COUPLE_FULL: 'В той паре уже двое',
  ALREADY_PAIRED: 'Ты уже в паре',
  OWN_CODE: 'Это твой собственный код',
  DB_NOT_CONFIGURED: 'База не подключена — заполни DATABASE_URL',
  UNAUTHORIZED: 'Telegram не подтвердил вход',
  SERVER_ERROR: 'Сервер не ответил',
};

type Props = {
  state: AppState;
  busy: boolean;
  error: string | null;
  onJoin: (code: string) => void;
};

export default function PairGate({ state, busy, error, onJoin }: Props) {
  const [code, setCode] = useState('');

  return (
    <>
      {error && <div className="pair-err">{ERRORS[error] ?? error}</div>}

      <div className="pair">
        <div className="pair-label">код для второго</div>
        <div className="pair-code">{state.couple.inviteCode}</div>
        <p className="pair-note">
          Отдай этот код. Она вводит его у себя — и всё, вы вдвоём в одном пространстве.
        </p>
      </div>

      <div className="capture">
        <div className="capture-row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.length === 6 && !busy) onJoin(code);
            }}
            placeholder="Или введи её код…"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <button
            onClick={() => onJoin(code)}
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

      <div className="footbar">
        <span>
          Приводка <b>ждём второго</b>
        </span>
        <span>слой: {state.me.ink === 'blue' ? 'синий' : 'розовый'}</span>
      </div>
    </>
  );
}
