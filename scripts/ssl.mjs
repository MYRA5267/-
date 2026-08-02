// Копия правила из src/lib/db/ssl.ts — скрипты на .mjs, импортировать TS
// отсюда нечем. Меняешь одно — поменяй и второе.
export function sslFor(connectionString) {
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) return undefined;
  return { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' };
}
