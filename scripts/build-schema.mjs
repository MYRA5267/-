// Собирает db/migrations/*.sql в один db/schema.sql — чтобы схему можно было
// накатить мышкой через веб-консоль базы, без терминала и без Node.
//
// Правь миграции, не schema.sql. После правки: node scripts/build-schema.mjs

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'db', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const head = `-- ОБА — вся схема одним файлом.
--
-- Открой консоль базы (в Neon: Project → SQL Editor), вставь этот файл
-- целиком и нажми Run. Повторный запуск безопасен — миграции идемпотентны.
--
-- Собрано из db/migrations/*.sql. Правь миграции, а не этот файл:
--   node scripts/build-schema.mjs

`;

const body = files
  .map((f) => {
    const rule = '─'.repeat(Math.max(0, 60 - f.length));
    return `-- ─── ${f} ${rule}\n\n${readFileSync(join(dir, f), 'utf8').trim()}`;
  })
  .join('\n\n\n');

writeFileSync(join(process.cwd(), 'db', 'schema.sql'), head + body + '\n');
console.log(`db/schema.sql собран из ${files.length} миграций`);
