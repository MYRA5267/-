import { DomainError, withAdmin, withUser } from '../db';
import { createIdea } from '../content';
import { approve, reject } from '../approvals';
import { escapeHtml } from '../connectors/telegram';

/**
 * Бот PULSE.
 *
 * Два дела, и оба из ТЗ: канал захвата идей («переслал сообщение боту —
 * оно в банке») и согласование прямо в чате, чтобы клиенту не приходилось
 * открывать интерфейс ради одного «да».
 *
 * Всё остальное бот не делает: он не читает чужие чаты, не публикует
 * без одобрения и не заводит людей — человек сначала открывает Mini App.
 */

const API = 'https://api.telegram.org';

export type InlineButton = { text: string; callback_data: string };

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    voice?: unknown;
    photo?: unknown;
    document?: unknown;
    forward_origin?: unknown;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
};

async function call(method: string, body: Record<string, unknown>): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // ответ бота не должен ронять обработку обновления
  }
}

const send = (chatId: number, text: string, buttons?: InlineButton[][]) =>
  call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });

/**
 * Одно обновление. Всегда завершается без исключения: Telegram
 * повторяет доставку на любой не-200, и одна кривая ошибка превратилась
 * бы в бесконечный поток одинаковых обновлений.
 */
export async function handleUpdate(update: Update): Promise<void> {
  try {
    if (update.callback_query) return await onCallback(update.callback_query);
    if (update.message) return await onMessage(update.message);
  } catch (e) {
    console.error('[pulse/bot]', e);
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) await send(chatId, 'Не получилось. Попробуй ещё раз или открой приложение.');
  }
}

// ─────────────────────────────────────────────────────────────
// Сообщения
// ─────────────────────────────────────────────────────────────

async function onMessage(message: NonNullable<Update['message']>): Promise<void> {
  const chatId = message.chat.id;
  const tgId = message.from?.id;
  if (!tgId || message.chat.type !== 'private') return;

  const text = (message.text ?? message.caption ?? '').trim();

  if (text.startsWith('/start')) return await onStart(chatId, tgId);
  if (text.startsWith('/projects')) return await onProjects(chatId, tgId);

  const person = await lookup(tgId);
  if (!person) return await onStart(chatId, tgId);

  // медиа принимаем честно: подпись сохраняем, файл пока нет
  const hasMedia = Boolean(message.voice || message.photo || message.document);
  if (!text) {
    await send(
      chatId,
      hasMedia
        ? 'Файлы и голос пока не сохраняю — хранилище появится следующим шагом. Пришли мысль текстом.'
        : 'Пришли мысль текстом — положу её в банк идей.',
    );
    return;
  }

  if (!person.currentProjectId) {
    await send(chatId, 'Сначала выбери проект.');
    return await onProjects(chatId, tgId);
  }

  const idea = await createIdea(tgId, {
    projectId: person.currentProjectId,
    sourceText: text,
  });

  const app = miniAppUrl(`/pulse/editor/${idea.id}`);
  await send(
    chatId,
    [
      `<b>Записал</b> в «${escapeHtml(person.currentProjectName ?? 'проект')}»`,
      escapeHtml(idea.title || text.slice(0, 80)),
      hasMedia ? '\nФайл не сохранён — только текст.' : '',
      app ? `\n${app}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function onStart(chatId: number, tgId: number): Promise<void> {
  const person = await lookup(tgId);
  const app = miniAppUrl('/pulse');

  if (!person) {
    await send(
      chatId,
      [
        '<b>PULSE Studio</b>',
        '',
        'Одна идея превращается в пакет публикаций для всех площадок.',
        '',
        'Открой приложение и создай пространство — после этого сможешь',
        'присылать мысли сюда, а они будут попадать в банк идей.',
        app ? `\n${app}` : '',
      ].join('\n'),
    );
    return;
  }

  await send(
    chatId,
    [
      `Привет, ${escapeHtml(person.name)}.`,
      '',
      'Присылай мысли текстом — положу в банк идей.',
      '/projects — выбрать проект',
      person.currentProjectName
        ? `\nСейчас пишу в «${escapeHtml(person.currentProjectName)}».`
        : '',
      app ? `\n${app}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

async function onProjects(chatId: number, tgId: number): Promise<void> {
  const projects = await withUser(tgId, async (client) => {
    const { rows } = await client.query<{ id: string; name: string }>(
      `select id, name from pulse.projects where status <> 'archived' order by created_at limit 20`,
    );
    return rows;
  });

  if (!projects.length) {
    await send(chatId, 'Проектов пока нет. Создай первый в приложении.');
    return;
  }

  await send(
    chatId,
    'Куда складывать идеи?',
    projects.map((p) => [{ text: p.name, callback_data: `prj:${p.id}` }]),
  );
}

// ─────────────────────────────────────────────────────────────
// Кнопки
// ─────────────────────────────────────────────────────────────

async function onCallback(query: NonNullable<Update['callback_query']>): Promise<void> {
  const tgId = query.from.id;
  const data = query.data ?? '';
  const chatId = query.message?.chat.id;

  const answer = (text: string) =>
    call('answerCallbackQuery', { callback_query_id: query.id, text });

  // выбор проекта
  if (data.startsWith('prj:')) {
    const projectId = data.slice(4);
    const name = await setCurrentProject(tgId, projectId);
    await answer(`Пишу в «${name}»`);
    if (chatId) await send(chatId, `Теперь идеи идут в «${escapeHtml(name)}».`);
    return;
  }

  // решение по согласованию
  if (data.startsWith('apr:')) {
    const [, approvalId, verdict] = data.split(':');
    try {
      if (verdict === 'ok') {
        await approve(tgId, approvalId);
        await answer('Одобрено');
        await replaceMarkup(query, '✓ Одобрено');
      } else {
        // возврат требует комментария — за ним отправляем в приложение,
        // потому что «верните» без причины бесполезно редактору
        await reject(tgId, approvalId, 'Возвращено из Telegram без комментария');
        await answer('Вернул автору');
        await replaceMarkup(query, '↩ Возвращено');
      }
    } catch (e) {
      const code = e instanceof DomainError ? e.code : 'SERVER_ERROR';
      await answer(
        code === 'CONTENT_CHANGED'
          ? 'Текст изменился — открой приложение'
          : code === 'ALREADY_DECIDED'
            ? 'Решение уже принято'
            : code === 'FORBIDDEN'
              ? 'Нет прав на решение'
              : 'Не получилось',
      );
    }
    return;
  }

  await answer('');
}

/** После решения кнопки убираем: повторное нажатие ничего не значит. */
async function replaceMarkup(
  query: NonNullable<Update['callback_query']>,
  suffix: string,
): Promise<void> {
  if (!query.message) return;
  await call('editMessageReplyMarkup', {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    reply_markup: { inline_keyboard: [[{ text: suffix, callback_data: 'noop' }]] },
  });
}

// ─────────────────────────────────────────────────────────────

type Person = {
  id: string;
  name: string;
  currentProjectId: string | null;
  currentProjectName: string | null;
};

/**
 * Кто написал. Привилегированный путь: человек мог ещё ни разу не
 * открывать приложение, и тогда RLS про него ничего не знает.
 */
async function lookup(tgId: number): Promise<Person | null> {
  return withAdmin(async (client) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      current_project_id: string | null;
      project_name: string | null;
    }>(
      `select u.id, u.name, u.current_project_id, p.name as project_name
         from pulse.users u
         left join pulse.projects p
                on p.id = u.current_project_id and p.status <> 'archived'
        where u.tg_id = $1`,
      [String(tgId)],
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      name: rows[0].name,
      currentProjectId: rows[0].project_name ? rows[0].current_project_id : null,
      currentProjectName: rows[0].project_name,
    };
  });
}

/** Смена проекта идёт под RLS: чужой проект человек себе не выберет. */
async function setCurrentProject(tgId: number, projectId: string): Promise<string> {
  return withUser(tgId, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `select name from pulse.projects where id = $1 and status <> 'archived'`,
      [projectId],
    );
    if (!rows[0]) throw new DomainError('PROJECT_NOT_FOUND', 404);

    const { rowCount } = await client.query(
      'update pulse.users set current_project_id = $1 where id = pulse.me()',
      [projectId],
    );
    if (!rowCount) throw new DomainError('FORBIDDEN', 403);
    return rows[0].name;
  });
}

function miniAppUrl(path: string): string | null {
  const base = process.env.PULSE_BASE_URL;
  return base ? `${base.replace(/\/$/, '')}${path}` : null;
}

/** Уведомление с кнопками решения — используется при запросе на согласование. */
export async function notifyWithButtons(
  chatId: string | number,
  text: string,
  buttons: InlineButton[][],
): Promise<void> {
  await call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons },
  });
}
