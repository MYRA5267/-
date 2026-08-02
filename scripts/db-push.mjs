// Прогоняет db/migrations/*.sql по порядку. Миграции идемпотентны.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { sslFor } from './ssl.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}

const dir = join(process.cwd(), 'db', 'migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const client = new pg.Client({
  connectionString: url,
  ssl: sslFor(url),
});
await client.connect();

for (const file of files) {
  process.stdout.write(`→ ${file} … `);
  await client.query(readFileSync(join(dir, file), 'utf8'));
  console.log('ok');
}

await client.end();
console.log(`\n${files.length} миграций применено.`);
