'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Item, Person } from '@/lib/types';
import PairGate from './PairGate';

const ENERGY = [
  { v: 1 as const, label: 'на исходе', o: 0.4 },
  { v: 2 as const, label: 'норма', o: 0.72 },
  { v: 3 as const, label: 'много', o: 1 },
];

type Tab = 'today' | 'wish' | 'home';

const TYPE_NAME: Record<string, string> = {
  wish: 'желание',
  home: 'быт',
  task: 'напоминание',
  date: 'наше время',
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

/**
 * Сбитая приводка = забывание. Чем дольше просрочено, тем сильнее
 * расходятся красочные слои. Пороги те же, что у эскалации в боте.
 */
function driftOf(item: Item): 0 | 1 | 2 {
  if (item.done || !item.dueAt) return 0;
  const late = Date.now() - new Date(item.dueAt).getTime();
  if (late <= 0) return 0;
  return late > 2 * 3600 * 1000 ? 2 : 1;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [tab, setTab] = useState<Tab>('today');
  const [draft, setDraft] = useState('');
  const [secret, setSecret] = useState(false);
  const initData = useRef<string | undefined>(undefined);

  const call = useCallback(async (url: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (initData.current) headers['x-telegram-init-data'] = initData.current;
    const res = await fetch(url, {
      method: body === undefined ? 'POST' : 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({ error: 'SERVER_ERROR' }));
    if (!res.ok) throw new Error(json.error ?? 'SERVER_ERROR');
    return json as AppState;
  }, []);

  const patch = useCallback(
    async (url: string, body: unknown, method: 'POST' | 'PATCH' = 'POST') => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (initData.current) headers['x-telegram-init-data'] = initData.current;
      const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({ error: 'SERVER_ERROR' }));
      if (!res.ok) throw new Error(json.error ?? 'SERVER_ERROR');
      return json as AppState;
    },
    [],
  );

  const run = useCallback(async (fn: () => Promise<AppState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      initData.current = await rawInitData();
      try {
        const next = await call('/api/state');
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

  if (busy && !state) return <div className="empty">Проявляется…</div>;

  if (state && !state.partner) {
    return (
      <PairGate
        state={state}
        busy={busy}
        error={error}
        onJoin={(code) => run(() => patch('/api/pair/join', { code }))}
      />
    );
  }

  if (!state) {
    return (
      <>
        {error && <div className="pair-err">{error}</div>}
        <div className="empty">Открой приложение внутри Telegram</div>
      </>
    );
  }

  const me = state.me;
  const partner = state.partner as Person;
  const inkClass = (p: Person) => (p.ink === 'blue' ? 'g' : 'm');
  const levelOf = (p: Person) => state.energy.find((e) => e.userId === p.id)?.level ?? 3;

  const ownerClass = (it: Item) => {
    if (it.ownerId === null) return 'both';
    return inkClass(it.ownerId === me.id ? me : partner);
  };
  const ownerName = (it: Item) => {
    if (it.ownerId === null) return 'Оба';
    return it.ownerId === me.id ? me.displayName : partner.displayName;
  };

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void run(() => patch('/api/items', { text, secret })).then(() => setSecret(false));
  };

  const groups: Array<[string, string, (i: Item) => boolean]> =
    tab === 'today'
      ? [
          ['Горит', 'сегодня', (i) => i.type === 'task' && !i.done],
          ['Закрыто', 'сегодня', (i) => i.type === 'task' && i.done],
        ]
      : tab === 'wish'
        ? [
            // имя в заголовке — именительным падежом: склонять чужие имена
            // мы не умеем, а «Список Юля» читать стыдно
            [partner.displayName, 'желания · видно обоим', (i) => i.type === 'wish' && i.ownerId === partner.id],
            [me.displayName, 'желания · видно обоим', (i) => i.type === 'wish' && i.ownerId === me.id],
            ['Хотим вдвоём', 'общее', (i) => i.type === 'wish' && i.ownerId === null],
          ]
        : [
            ['Надо взять', 'общая корзина', (i) => i.type === 'home' && !i.done],
            ['Взято', 'за неделю', (i) => i.type === 'home' && i.done],
          ];

  const live = state.items.filter((i) => !i.done);
  const steady = live.filter((i) => driftOf(i) === 0).length;

  const card = (it: Item) => {
    const drift = driftOf(it);
    const isWish = it.type === 'wish';
    const mine = it.ownerId === me.id;
    const claimedByMe = it.claimedBy === me.id;

    return (
      <article
        key={it.id}
        className={`card${it.done ? ' done' : ''}${it.secret ? ' secret' : ''}`}
        data-owner={ownerClass(it)}
        data-drift={drift}
      >
        <span className="ink ink-b" />
        <span className="ink ink-p" />
        <div className="meta">
          <span className={`who ${ownerClass(it)}`}>{ownerName(it)}</span>
          <span>{TYPE_NAME[it.type]}</span>
          {it.secret && <span>скрыто от {partner.displayName}</span>}
          {drift === 2 && !it.done && <span>приводка сбита</span>}
        </div>
        <div className="card-text">{it.text}</div>
        {it.note && <div className="card-sub">{it.note}</div>}
        {it.price && <div className="price">{it.price}</div>}

        <div className="actions">
          {isWish && !mine ? (
            <button
              className={`act${claimedByMe ? '' : ' hot'}`}
              disabled={busy}
              onClick={() => void run(() => patch(`/api/items/${it.id}`, { claimed: !claimedByMe }, 'PATCH'))}
            >
              {claimedByMe ? 'Передумал' : 'Беру на себя'}
            </button>
          ) : !isWish ? (
            <button
              className="act"
              disabled={busy}
              onClick={() => void run(() => patch(`/api/items/${it.id}`, { done: !it.done }, 'PATCH'))}
            >
              {it.done ? 'Вернуть' : 'Готово'}
            </button>
          ) : null}
        </div>

        {isWish && claimedByMe && (
          <div className="seal">
            Ты берёшь это. {partner.displayName} не видит отметку.
          </div>
        )}
      </article>
    );
  };

  let printed = 0;

  return (
    <>
      <style>{`:root{--o-blue:${ENERGY[levelOf(state.me.ink === 'blue' ? me : partner) - 1].o};--o-pink:${ENERGY[levelOf(state.me.ink === 'pink' ? me : partner) - 1].o}}`}</style>

      <div className="energy">
        <div className="energy-head">Сколько нас сегодня</div>
        {[me, partner].map((p) => (
          <div className="erow" key={p.id}>
            <span className={`ename ${inkClass(p)}`}>{p.displayName}</span>
            <div className={`swatch${p.id === me.id ? '' : ' locked'}`}>
              {ENERGY.map((e) => (
                <i
                  key={e.v}
                  className={inkClass(p) === 'g' ? 'sg' : 'sm'}
                  data-on={levelOf(p) >= e.v ? '1' : '0'}
                  title={p.id === me.id ? e.label : undefined}
                  onClick={
                    p.id === me.id
                      ? () => void run(() => patch('/api/energy', { level: e.v }))
                      : undefined
                  }
                />
              ))}
            </div>
            <span className="elabel">{ENERGY[levelOf(p) - 1].label}</span>
          </div>
        ))}
      </div>

      <div className={`capture${secret ? ' secret' : ''}`}>
        <div className="capture-row">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder={secret ? `Скрыто от ${partner.displayName} полностью…` : 'Кинь строку или ссылку…'}
            autoComplete="off"
          />
          <button onClick={add} disabled={busy || !draft.trim()} aria-label="Добавить">
            +
          </button>
        </div>
        <div className="capture-foot">
          <span>разложу сам: напоминание · желание · быт</span>
          <button
            className="sbtn"
            aria-pressed={secret}
            onClick={() => setSecret((s) => !s)}
          >
            Секрет
          </button>
        </div>
      </div>

      <nav className="tabs" role="tablist">
        {([['today', 'Сегодня'], ['wish', 'Желания'], ['home', 'Быт']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>

      <main>
        {error && <div className="pair-err">{error}</div>}
        {groups.map(([title, note, filter]) => {
          const list = state.items.filter(filter);
          if (!list.length) return null;
          printed += list.length;
          return (
            <section className="section" key={title}>
              <div className="section-head">
                <h2>{title}</h2>
                <em>{note}</em>
              </div>
              <div className="stack">{list.map(card)}</div>
            </section>
          );
        })}
        {printed === 0 && (
          <div className="empty">Пусто. Кинь строку наверх — разложу сам.</div>
        )}
      </main>

      <div className="footbar">
        <span>
          Приводка <b>{steady} из {live.length} в норме</b>
        </span>
        <span>
          слой: {me.ink === 'blue' ? 'синий' : 'розовый'} · {ENERGY[levelOf(me) - 1].label}
        </span>
      </div>
    </>
  );
}
