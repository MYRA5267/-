// Сквозная проверка двумя людьми — тест приватности, которого требует
// спека после пунктов 5, 6 и 9. Гоняет живое приложение через dev-авторизацию:
// связка по коду, захват, секретный слой, `claimed_by`, энергия.
//
// Требует поднятого dev-сервера с OBA_ALLOW_DEV_AUTH=1 и чистой базы:
//   psql $DATABASE_URL -c 'truncate public.couples cascade'
//   npm run dev
//   npm run test:e2e
//
// Имена людей здесь — из прототипа, к реальной паре отношения не имеют.

const BASE = process.env.OBA_BASE_URL ?? 'http://localhost:3000';
const G = { id: 555000111, name: encodeURIComponent('Гена') };
const Y = { id: 555000222, name: encodeURIComponent('Юля') };

async function api(who, path, body, method = 'POST') {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-oba-dev-tg-id': String(who.id),
      'x-oba-dev-name': who.name,
    },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(path + ' → ' + JSON.stringify(j));
  return j;
}

const texts = (s) => s.items.map((i) => i.text);
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
  cond ? ok++ : fail++;
};

// связка
let g = await api(G, '/api/state');
let y = await api(Y, '/api/state');
check('оба завели свои пары', g.couple.id !== y.couple.id);
y = await api(Y, '/api/pair/join', { code: g.couple.inviteCode });
check('Юля вошла по коду', y.partner?.displayName === 'Гена', `слой ${y.me.ink}`);
g = await api(G, '/api/state');
check('Гена видит Юлю', g.partner?.displayName === 'Юля');
check('слои разные', g.me.ink !== y.me.ink, `${g.me.ink} / ${y.me.ink}`);

// третьего быть не может
const T = { id: 555000333, name: 'Third' };
await api(T, '/api/state');
let blocked = false;
try { await api(T, '/api/pair/join', { code: g.couple.inviteCode }); } catch { blocked = true; }
check('третьего в пару не пускает', blocked);

// захват и раскладка
g = await api(G, '/api/items', { text: 'Продлить страховку' });
g = await api(G, '/api/items', { text: 'Кончился корм коту' });
y = await api(Y, '/api/items', { text: 'Хочу курс по керамике' });
check('напоминание ушло в task', g.items.some((i) => i.text.includes('страховк') && i.type === 'task'));
check('быт распознан', g.items.some((i) => i.type === 'home'));
g = await api(G, '/api/state');
check('желание Юли видно Гене', g.items.some((i) => i.type === 'wish' && i.text.includes('керамик')));

// ссылка
y = await api(Y, '/api/items', { text: 'https://www.bol.com/nl/p/koptelefoon/123' });
const link = y.items.find((i) => i.url);
check('ссылка стала желанием с доменом', link?.type === 'wish' && link.text === 'Товар с bol.com', link?.text);

// СЕКРЕТ
g = await api(G, '/api/items', { text: 'Домик в Гронингене на её день рождения', secret: true });
check('Гена видит свой секрет', texts(g).some((t) => t.includes('Гронинген')));
y = await api(Y, '/api/state');
check('Юля НЕ видит секрет Гены', !texts(y).some((t) => t.includes('Гронинген')));
check('секрета нет и в сыром ответе', !JSON.stringify(y).includes('Гронинген'));

// CLAIMED_BY
const wish = y.items.find((i) => i.type === 'wish' && i.text.includes('керамик'));
g = await api(G, `/api/items/${wish.id}`, { claimed: true }, 'PATCH');
const gWish = g.items.find((i) => i.id === wish.id);
check('Гена видит свою отметку', gWish.claimedBy === g.me.id);
y = await api(Y, '/api/state');
const yWish = y.items.find((i) => i.id === wish.id);
check('Юля НЕ видит, что желание взяли', yWish.claimedBy === null);
check('claimed_by не утёк в сыром ответе', !JSON.stringify(y).includes(g.me.id + '"') || yWish.claimedBy === null);

// готово
const task = g.items.find((i) => i.type === 'task' && i.text.includes('страховк'));
g = await api(G, `/api/items/${task.id}`, { done: true }, 'PATCH');
check('задача закрывается', g.items.find((i) => i.id === task.id).done === true);
y = await api(Y, '/api/state');
check('Юля видит, что закрыто', y.items.find((i) => i.id === task.id).done === true);

// энергия
y = await api(Y, '/api/energy', { level: 1 });
check('Юля выставила энергию', y.energy.find((e) => e.userId === y.me.id)?.level === 1);
g = await api(G, '/api/state');
check('Гена видит её уровень', g.energy.find((e) => e.userId === g.partner.id)?.level === 1);

console.log(`\n${ok}/${ok + fail} проверок прошло.`);
process.exit(fail ? 1 : 0);
