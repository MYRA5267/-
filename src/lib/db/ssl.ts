/**
 * Одно правило TLS на весь проект: локально — без него, наружу — всегда
 * с проверкой сертификата. У Neon сертификат валидный, проверка проходит.
 *
 * PGSSL_NO_VERIFY=1 — единственная лазейка, для хостингов с самоподписанным
 * CA (например, прямое подключение к Supabase). Больше нигде не отключаем.
 */
export function sslFor(connectionString: string) {
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString)) return undefined;
  return { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1' };
}
