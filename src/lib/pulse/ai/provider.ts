/**
 * Адаптер модели.
 *
 * Редактор, humanizer и аналитика разговаривают только с этим интерфейсом.
 * Поменять модель или провайдера — значит дописать реализацию здесь,
 * не трогая ни один экран.
 */

export type JsonRequest = {
  system: string;
  prompt: string;
  /** JSON Schema ответа. Провайдер обязан вернуть строго по ней. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Насколько глубоко думать. Рутине хватает low. */
  effort?: 'low' | 'medium' | 'high';
};

export type TextRequest = {
  system: string;
  prompt: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
};

export interface AiProvider {
  /** Имя видно в интерфейсе: человек должен знать, кто написал текст. */
  readonly name: string;
  /** true — работает настоящая модель; false — офлайн-заглушка. */
  readonly live: boolean;
  json<T>(req: JsonRequest): Promise<T>;
  text(req: TextRequest): Promise<string>;
}

const MODEL = process.env.PULSE_AI_MODEL || 'claude-opus-5';

class AnthropicProvider implements AiProvider {
  readonly name = MODEL;
  readonly live = true;

  private client: unknown;

  private async sdk() {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    // тип SDK не протекает наружу: адаптер — единственное место, где он нужен
    return this.client as {
      messages: {
        create(args: Record<string, unknown>): Promise<{
          content: Array<{ type: string; text?: string }>;
          stop_reason?: string | null;
        }>;
      };
    };
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const client = await this.sdk();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      output_config: {
        effort: req.effort ?? 'medium',
        format: { type: 'json_schema', schema: req.schema },
      },
      messages: [{ role: 'user', content: req.prompt }],
    });

    // отказ приходит успешным ответом с пустым содержимым — читаем причину,
    // а не индекс content[0]
    if (response.stop_reason === 'refusal') {
      throw new AiError('AI_REFUSED', 'Модель отказалась отвечать на этот материал');
    }

    const raw = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!raw.trim()) throw new AiError('AI_EMPTY', 'Модель вернула пустой ответ');

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new AiError('AI_BAD_JSON', 'Модель вернула не JSON');
    }
  }

  async text(req: TextRequest): Promise<string> {
    const client = await this.sdk();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      output_config: { effort: req.effort ?? 'low' },
      messages: [{ role: 'user', content: req.prompt }],
    });
    if (response.stop_reason === 'refusal') {
      throw new AiError('AI_REFUSED', 'Модель отказалась отвечать на этот материал');
    }
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
  }
}

export class AiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

let cached: AiProvider | null = null;
let overridden = false;

/**
 * null — модели нет. Вызывающий обязан это обработать: у каждого места,
 * где мы зовём модель, есть честный офлайн-путь, и мы показываем человеку,
 * что текст собран без неё. Молча притворяться моделью нельзя.
 */
export function aiProvider(): AiProvider | null {
  if (overridden) return cached;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!cached) cached = new AnthropicProvider();
  return cached;
}

/** Только для тестов: подменить провайдера. */
export function setAiProvider(provider: AiProvider | null): void {
  cached = provider;
  overridden = true;
}
