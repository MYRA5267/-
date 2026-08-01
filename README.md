# ОБА

Telegram Mini App для двоих. Спека — `docs/oba_claude_code_spec.md`,
визуальный референс — `docs/oba_miniapp_prototype.html`.

Сделан **пункт 1** из «Порядка работы»: схема + RLS + проверка `initData` +
связка пары по коду. Экраны, ИИ-разбор и cron — следующими шагами.

## Запуск

```bash
cp .env.example .env.local   # TELEGRAM_BOT_TOKEN + DATABASE_URL
npm install
npm run db:push              # прогнать supabase/migrations/*.sql
npm run db:rls-check         # убедиться, что RLS не пускает лишнего
npm run dev
```

Локально без Telegram: `OBA_ALLOW_DEV_AUTH=1` и `OBA_DEV_TG_ID=900000001`
в `.env.local`. В production этот путь выключен жёстко.

## Как устроен доступ к базе

Одна дверь: `src/lib/auth.ts` берёт `tg_id` только из подписанного
`initData` (`src/lib/telegram/verify.ts`), никогда из тела запроса.

Дальше два пути в `src/lib/db/pool.ts`:

- `withUser(tgId, fn)` — обычный путь. Транзакция с
  `set local role authenticated` и `app.tg_id`, всё под RLS.
- `withAdmin(fn)` — владелец схемы, RLS не действует. Только там, где
  человека ещё нет в базе: завести пару при первом входе и связать двоих
  по коду. Больше нигде.

Изоляция пары и секретный слой живут в политиках (`supabase/migrations/0001_init.sql`),
а не в коде приложения. Секретный пункт физически не выходит из Postgres
к партнёру — проверка одна, в политике.

## Связка

Первый вход создаёт пару и код из 6 символов. Второй вводит код —
`unique (couple_id, ink)` на `users` закрывает связку навсегда: третьего
в паре быть не может.
