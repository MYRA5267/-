// Worker очереди PULSE.
//
// Дёргает /api/pulse/worker с интервалом. Отдельный процесс, а не часть
// экранов: публикации не должны зависеть от того, открыл ли кто-то
// приложение. На платформах с собственным cron этот скрипт не нужен —
// достаточно вызывать тот же роут по расписанию.
//
//   PULSE_WORKER_SECRET=... PULSE_BASE_URL=https://... node scripts/pulse-worker.mjs
//
// Флаги: --once (один проход), --interval=<секунды>

const base = process.env.PULSE_BASE_URL ?? 'http://localhost:3000';
const secret = process.env.PULSE_WORKER_SECRET;
const once = process.argv.includes('--once');
const intervalArg = process.argv.find((a) => a.startsWith('--interval='));
const intervalSec = intervalArg ? Number(intervalArg.split('=')[1]) : 30;

if (!secret) {
  console.error('PULSE_WORKER_SECRET не задан — служебный вызов не пройдёт');
  process.exit(1);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    console.log('\nОстанавливаемся после текущего прохода.');
  });
}

async function tick() {
  const response = await fetch(`${base}/api/pulse/worker?limit=10`, {
    method: 'POST',
    headers: { 'x-pulse-worker-secret': secret },
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`${new Date().toISOString()} ошибка ${response.status}: ${text}`);
    return;
  }
  const result = JSON.parse(text);
  // тишину не логируем: пустой проход — норма
  if (result.claimed > 0) {
    console.log(
      `${new Date().toISOString()} взято ${result.claimed}, опубликовано ${result.published}, ` +
        `повторим ${result.retried}, остановлено ${result.failed}`,
    );
  }
}

async function main() {
  if (once) {
    await tick();
    return;
  }
  console.log(`Очередь PULSE: ${base}, каждые ${intervalSec} с. Ctrl+C — выход.`);
  while (!stopping) {
    try {
      await tick();
    } catch (e) {
      console.error(`${new Date().toISOString()} сеть не ответила: ${e.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
