import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canTransition,
  isEditable,
  isErrorStatus,
  isRegeneratable,
  statusAfterEdit,
} from '../src/lib/pulse/status';
import { escapeHtml } from '../src/lib/pulse/connectors/telegram';
import { DomainError } from '../src/lib/pulse/db';
import { optionalUuid, requireOneOf, uuid } from '../src/lib/pulse/http';
import { humanize } from '../src/lib/pulse/ai/humanizer';
import { checkQuality, hasBlockers } from '../src/lib/pulse/ai/quality';
import { analyze, scoreOf } from '../src/lib/pulse/ai/copilot';
import { contentHash, idempotencyKey } from '../src/lib/pulse/crypto';
import { renderBody, retryDelayMs } from '../src/lib/pulse/connectors/types';
import { buildExportPackage } from '../src/lib/pulse/connectors/export';
import { horizonFor } from '../src/lib/pulse/analytics';
import { offlinePack } from '../src/lib/pulse/ai/generate';
import { PLATFORMS, type BrandProfile, type ContentPack } from '../src/lib/pulse/types';

describe('статусная модель', () => {
  it('ведёт материал по заявленному пути', () => {
    assert.ok(canTransition('IDEA', 'DRAFT'));
    assert.ok(canTransition('DRAFT', 'IN_REVIEW'));
    assert.ok(canTransition('IN_REVIEW', 'APPROVED'));
    assert.ok(canTransition('APPROVED', 'SCHEDULED'));
    assert.ok(canTransition('SCHEDULED', 'PUBLISHING'));
    assert.ok(canTransition('PUBLISHING', 'PUBLISHED'));
    assert.ok(canTransition('PUBLISHED', 'MEASURING'));
    assert.ok(canTransition('MEASURING', 'ANALYZED'));
  });

  it('не даёт перепрыгнуть одобрение', () => {
    assert.equal(canTransition('DRAFT', 'APPROVED'), false);
    assert.equal(canTransition('DRAFT', 'SCHEDULED'), false);
    assert.equal(canTransition('IDEA', 'PUBLISHED'), false);
  });

  it('правка после одобрения сбрасывает статус в черновик', () => {
    assert.equal(statusAfterEdit('APPROVED'), 'DRAFT');
    assert.equal(statusAfterEdit('SCHEDULED'), 'DRAFT');
    assert.equal(statusAfterEdit('IN_REVIEW'), 'DRAFT');
    // опубликованное правкой уже не отменить
    assert.equal(statusAfterEdit('PUBLISHED'), 'PUBLISHED');
  });

  it('различает ошибочные состояния', () => {
    assert.ok(isErrorStatus('RATE_LIMITED'));
    assert.ok(isErrorStatus('FAILED_FINAL'));
    assert.equal(isErrorStatus('APPROVED'), false);
    // из ошибки возвращаемся руками
    assert.ok(canTransition('AUTH_REQUIRED', 'DRAFT'));
  });
});

describe('идемпотентность и снимок текста', () => {
  const base = { body: 'Текст', firstHook: 'Крючок', cta: 'Переходи' };

  it('одинаковый текст даёт одинаковый хэш', () => {
    assert.equal(contentHash(base), contentHash({ ...base }));
  });

  it('любая правка меняет хэш', () => {
    assert.notEqual(contentHash(base), contentHash({ ...base, body: 'Текст.' }));
    assert.notEqual(contentHash(base), contentHash({ ...base, cta: 'Купи' }));
  });

  it('ключ задачи стабилен для той же публикации и меняется после правки', () => {
    const hash = contentHash(base);
    assert.equal(idempotencyKey('s1', hash), idempotencyKey('s1', hash));
    assert.notEqual(idempotencyKey('s1', hash), idempotencyKey('s2', hash));
    assert.notEqual(idempotencyKey('s1', hash), idempotencyKey('s1', contentHash({ ...base, body: 'x' })));
  });
});

describe('humanizer', () => {
  it('ловит клише и канцелярит', () => {
    const found = humanize('В современном мире реализация проектов осуществляется быстрее.');
    const codes = found.map((f) => f.code);
    assert.ok(codes.includes('CLICHE'));
    assert.ok(codes.includes('BUREAUCRATIC'));
  });

  it('ловит симметричные противопоставления', () => {
    const found = humanize(
      'Это не просто инструмент, а система. Мы делаем не быстро, а правильно.',
    );
    assert.ok(found.some((f) => f.code === 'FAKE_CONTRAST'));
  });

  it('молчит на живом тексте', () => {
    const found = humanize(
      'Вчера потерял два часа на баг в очереди.\n\nОказалось, дело в блокировке. ' +
        'Поправил одной строкой, а искал полдня. Теперь пишу тесты на такие вещи сразу.',
    );
    assert.deepEqual(found, []);
  });
});

describe('проверка качества', () => {
  const brand: BrandProfile = {
    projectId: 'p1',
    positioning: '',
    audiences: [],
    voice: {},
    prohibitedPhrases: ['лучший на рынке'],
    examples: { good: [], bad: [] },
    facts: [{ claim: 'выручка 12 млн' }],
    defaultCta: '',
  };

  it('останавливает запрещённую формулировку', () => {
    const findings = checkQuality({
      platform: 'telegram',
      firstHook: 'Мы лучший на рынке продукт',
      body: 'И вот почему это действительно так, если посмотреть внимательнее на детали.',
      cta: '',
      brand,
    });
    assert.ok(hasBlockers(findings));
    assert.ok(findings.some((f) => f.code === 'PROHIBITED_PHRASE'));
  });

  it('останавливает превышение жёсткого предела площадки', () => {
    const findings = checkQuality({
      platform: 'threads',
      firstHook: 'Крючок понятный без контекста',
      body: 'а'.repeat(600),
      cta: '',
      brand: null,
    });
    assert.ok(findings.some((f) => f.code === 'THREAD_POST_TOO_LONG'));
  });

  it('просит проверить цифры, которых нет в фактах проекта', () => {
    const findings = checkQuality({
      platform: 'telegram',
      firstHook: 'Выручка выросла на 47 процентов за квартал',
      body: 'Разбираю, откуда взялся рост и что из этого повторяемо на следующий квартал.',
      cta: '',
      brand,
    });
    const numbers = findings.find((f) => f.code === 'UNVERIFIED_NUMBERS');
    assert.ok(numbers);
    assert.equal(numbers?.level, 'ask');
  });

  it('замечает повтор недавней публикации', () => {
    const hook = 'Скорость разработки позволяет быстрее создавать ненужные продукты';
    const findings = checkQuality({
      platform: 'telegram',
      firstHook: hook,
      body: 'Дальше подробный разбор того, почему так выходит и что с этим делать.',
      cta: '',
      brand: null,
      recentHooks: [hook],
    });
    assert.ok(findings.some((f) => f.code === 'REPEATS_RECENT'));
  });

  it('пропускает нормальный пост', () => {
    const findings = checkQuality({
      platform: 'telegram',
      firstHook: 'Очередь публикаций сломалась из-за одной блокировки',
      body: 'Два воркера брали одну задачу. Помог skip locked.\n\nТеперь пост уходит один раз.',
      cta: 'Расскажу подробнее в комментариях',
      brand: null,
    });
    assert.equal(hasBlockers(findings), false);
  });
});

describe('аналитика', () => {
  it('считает показатель на 1000 просмотров, а не в абсолюте', () => {
    const small = scoreOf({ views: 1000, saves: 50, profileVisits: 20 });
    const big = scoreOf({ views: 100000, saves: 50, profileVisits: 20 });
    assert.ok(small > big, 'точный маленький пост не должен проигрывать большому пустому');
  });

  it('раскладывает материалы на 20/60/20', () => {
    const publications = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      title: `Пост ${i}`,
      platform: 'telegram' as const,
      publishedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      metrics: { views: 1000, saves: (i + 1) * 5 },
    }));

    const digest = analyze(publications);
    assert.equal(digest.scored.filter((s) => s.band === 'top').length, 2);
    assert.equal(digest.scored.filter((s) => s.band === 'bottom').length, 2);
    assert.equal(digest.scored.filter((s) => s.band === 'middle').length, 6);
    assert.equal(digest.best?.id, 'p9');
    assert.ok(digest.nextHypothesis.length > 0);
  });

  it('не выдумывает выводы без метрик', () => {
    const digest = analyze([
      {
        id: 'p1',
        title: 'Пост',
        platform: 'telegram',
        publishedAt: new Date().toISOString(),
        metrics: null,
      },
    ]);
    assert.equal(digest.best, null);
    assert.equal(digest.nextHypothesis, '');
  });

  it('выбирает срез по возрасту публикации', () => {
    const now = new Date('2026-08-14T12:00:00Z');
    assert.equal(horizonFor('2026-08-14T10:00:00Z', now), 'manual');
    assert.equal(horizonFor('2026-08-13T10:00:00Z', now), 'h24');
    assert.equal(horizonFor('2026-08-11T10:00:00Z', now), 'h72');
    assert.equal(horizonFor('2026-08-01T10:00:00Z', now), 'd7');
  });
});

describe('отправка на площадку', () => {
  it('не дублирует крючок, если текст уже с него начинается', () => {
    const text = renderBody({
      firstHook: 'Первая строка',
      body: 'Первая строка\n\nДальше текст',
      cta: 'Переходи',
    });
    assert.equal(text.match(/Первая строка/g)?.length, 1);
    assert.ok(text.endsWith('Переходи'));
  });

  it('не приписывает призыв, который уже внутри текста', () => {
    const text = renderBody({
      firstHook: 'Крючок',
      body: 'Текст с призывом: подпишись',
      cta: 'подпишись',
    });
    assert.equal(text.match(/подпишись/g)?.length, 1);
  });

  it('увеличивает паузу между попытками', () => {
    const delays = [0, 1, 2, 3].map(retryDelayMs);
    for (let i = 1; i < delays.length; i += 1) {
      assert.ok(delays[i] > delays[i - 1]);
    }
    assert.ok(delays[3] <= 60 * 60_000);
  });
});

describe('офлайн-черновик и экспорт', () => {
  const input = {
    sourceText:
      'Сегодня понял, что скорость разработки позволяет быстрее создавать ненужные продукты. ' +
      'Проверять спрос стало дороже, чем писать код.',
    objective: 'trust' as const,
    audience: 'основатели',
    platforms: ['telegram', 'threads', 'tiktok'] as const,
    brand: null,
    recentHooks: [],
  };

  it('собирает версию под каждую площадку и не повторяет один текст', () => {
    const pack = offlinePack({ ...input, platforms: [...input.platforms] });
    assert.equal(pack.variants.length, 3);
    assert.equal(pack.producedBy, 'offline');

    const bodies = pack.variants.map((v) => v.body);
    assert.equal(new Set(bodies).size, 3, 'версии не должны совпадать дословно');
    // сценарий видео обязан выглядеть сценарием
    assert.match(pack.variants[2].body, /Первый кадр/);
  });

  it('честно помечает, что собрано без модели', () => {
    const pack = offlinePack({ ...input, platforms: ['telegram'] });
    assert.match(pack.variants[0].notes, /без модели/);
  });

  it('складывает экспорт-пакет по файлу на площадку', () => {
    const pack: ContentPack = {
      item: {
        id: 'c1',
        projectId: 'p1',
        title: 'Скорость разработки',
        sourceText: input.sourceText,
        objective: 'trust',
        audience: '',
        status: 'APPROVED',
        ideaState: 'in_progress',
        createdAt: new Date().toISOString(),
        variantCount: 2,
      },
      variants: [
        {
          id: 'v1',
          contentItemId: 'c1',
          platform: 'instagram',
          kind: 'caption',
          body: 'Подпись',
          firstHook: 'Крючок',
          cta: 'Ссылка в профиле',
          metadata: { hashtags: ['продукт'] },
          version: 1,
          status: 'APPROVED',
          approvedHash: 'abc',
        },
        {
          id: 'v2',
          contentItemId: 'c1',
          platform: 'tiktok',
          kind: 'script',
          body: 'Сценарий',
          firstHook: 'Другой крючок',
          cta: '',
          metadata: {},
          version: 1,
          status: 'APPROVED',
          approvedHash: 'def',
        },
      ],
    };

    const built = buildExportPackage(pack, 'SEZGI');
    const names = built.files.map((f) => f.name);
    assert.deepEqual(names, ['README.md', 'instagram.md', 'tiktok.md', 'pack.json']);
    assert.match(built.fileName, /^pulse-/);
    assert.match(built.files[1].content, /#продукт/);

    const parsed = JSON.parse(built.files[3].content);
    assert.equal(parsed.variants.length, 2);
    assert.equal(parsed.project, 'SEZGI');
  });
});

describe('одобренное и опубликованное неприкосновенны', () => {
  it('опубликованное не правят', () => {
    assert.equal(isEditable('PUBLISHED'), false);
    assert.equal(isEditable('PUBLISHING'), false);
    assert.equal(isEditable('MEASURING'), false);
    assert.equal(isEditable('ANALYZED'), false);
  });

  it('всё до отправки править можно, включая упавшее', () => {
    assert.ok(isEditable('DRAFT'));
    assert.ok(isEditable('APPROVED'));
    assert.ok(isEditable('SCHEDULED'));
    assert.ok(isEditable('FAILED_FINAL'));
  });

  it('перегенерация не затирает решение человека', () => {
    assert.ok(isRegeneratable('DRAFT'));
    assert.ok(isRegeneratable('CHANGES_REQUESTED'));
    assert.equal(isRegeneratable('APPROVED'), false);
    assert.equal(isRegeneratable('SCHEDULED'), false);
    assert.equal(isRegeneratable('PUBLISHED'), false);
  });
});

describe('в канал уходит ровно то, что одобрили', () => {
  it('разметку не отдаём площадке как разметку', () => {
    // согласующий видит эти символы буквами — подписчик обязан увидеть так же
    const text = escapeHtml('Смотри <a href="https://evil.example">тут</a> & дальше');
    assert.equal(
      text,
      'Смотри &lt;a href="https://evil.example"&gt;тут&lt;/a&gt; &amp; дальше',
    );
    assert.equal(text.includes('<a '), false);
  });

  it('обычный текст с угловой скобкой не валит отправку', () => {
    const body = renderBody({
      firstHook: 'Цена < 1000 рублей',
      body: 'И это меняет всё для команд из 3 человек.',
      cta: '',
    });
    const sent = escapeHtml(body);
    assert.equal(sent.includes('<'), false);
    assert.ok(sent.includes('&lt;'));
  });

  it('экранирование идемпотентных сюрпризов не даёт', () => {
    assert.equal(escapeHtml('чисто'), 'чисто');
  });
});

describe('проверка входных данных', () => {
  it('мусор вместо идентификатора — понятная ошибка, а не 500', () => {
    assert.throws(() => uuid(''), (e: unknown) => e instanceof DomainError && e.status === 400);
    assert.throws(() => uuid('123'), (e: unknown) => e instanceof DomainError);
    assert.throws(() => uuid(null), (e: unknown) => e instanceof DomainError);
    assert.throws(
      () => uuid('../../etc/passwd'),
      (e: unknown) => e instanceof DomainError,
    );
  });

  it('настоящий идентификатор проходит', () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    assert.equal(uuid(id), id);
    assert.equal(optionalUuid(undefined), undefined);
    assert.equal(optionalUuid(''), undefined);
    assert.equal(optionalUuid(id), id);
  });

  it('значение вне списка не доезжает до базы', () => {
    assert.equal(requireOneOf('telegram', PLATFORMS, 'BAD_PLATFORM'), 'telegram');
    assert.throws(
      () => requireOneOf('vk', PLATFORMS, 'BAD_PLATFORM'),
      (e: unknown) => e instanceof DomainError && e.code === 'BAD_PLATFORM',
    );
  });
});
