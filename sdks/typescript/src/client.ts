/** Potion client (SPEC §13.2) — thin wrapper over the official `openai` client. */

import OpenAI, { APIError } from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';
import type { ClientOptions } from 'openai';

/** Minimal per-request options (version-proof subset of openai's
 * RequestOptions) — forwarded to the underlying client verbatim. */
export interface PotionRequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}

import { mapError, type PotionErrorBody } from './errors.js';
import { FrontierTrace, type PotionRouting } from './types.js';

/** Wire params for chat.completions.create plus the Potion `policy` override. */
export type PotionChatCompletionCreateParams = ChatCompletionCreateParams & {
  /** Policy id or name, sent as `X-Potion-Policy` (this request only). */
  policy?: string;
};

/**
 * A {@link ChatCompletion} plus Potion metadata.
 *
 * Every field of the underlying completion (`id`, `choices`, `usage`, …) is
 * exposed, so existing OpenAI-shaped code keeps working; the Potion
 * additions are:
 *
 * - {@link PotionChatCompletion.frontierTrace} — parsed from the
 *   `x-frontier-trace` response header (`null` when the header is absent,
 *   e.g. a non-Potion backend);
 * - {@link PotionChatCompletion.cost} — `usage.cost` (USD) when the server
 *   reports one, else `null`;
 * - {@link PotionChatCompletion.routing} — the top-level `potion` routing
 *   object (requested vs resolved cluster and policy, the model that
 *   answered, `fallback` + `fallback_reason`), `null` when absent.
 */
export class PotionChatCompletion {
  /** The raw completion as returned by the openai client. */
  readonly completion: ChatCompletion;
  readonly frontierTrace: FrontierTrace | null;
  readonly cost: number | null;
  /** The top-level `potion` routing object (`null` on a non-Potion backend or a stream). */
  readonly routing: PotionRouting | null;

  constructor(completion: ChatCompletion, headers: Headers) {
    this.completion = completion;
    this.frontierTrace = FrontierTrace.parse(headers.get('x-frontier-trace'));
    const withRouting = completion as ChatCompletion & { potion?: PotionRouting };
    this.routing = withRouting.potion && typeof withRouting.potion === 'object' ? withRouting.potion : null;
    const usage = completion.usage as (ChatCompletion['usage'] & { cost?: number }) | undefined;
    this.cost = typeof usage?.cost === 'number' ? usage.cost : null;
  }

  get id(): string {
    return this.completion.id;
  }

  get object(): string {
    return this.completion.object;
  }

  get created(): number {
    return this.completion.created;
  }

  get model(): string {
    return this.completion.model;
  }

  get choices(): ChatCompletion['choices'] {
    return this.completion.choices;
  }

  get usage(): ChatCompletion['usage'] {
    return this.completion.usage;
  }

  toJSON(): ChatCompletion {
    return this.completion;
  }
}

export interface PotionOptions extends Omit<ClientOptions, 'baseURL' | 'apiKey'> {
  /** Gateway origin, e.g. `"http://localhost:3000"` (`/v1` added when missing). */
  baseUrl: string;
  /** Potion api key (`pk_…`). */
  apiKey: string;
  /** Policy id or name sent as `X-Potion-Policy` on every request unless
   * overridden per-request with `policy`. */
  defaultPolicy?: string;
}

/** G1 Outcome API signals — what ACTUALLY happened after a served response.
 * The server requires at least one signal per report. */
export interface OutcomeSignals {
  success?: boolean;
  /** Customer-defined score on [0,1]. */
  score?: number;
  /** Name of the check that produced the signal (e.g. 'tests_passed'). */
  validator?: string;
  /** The correct answer/class per your application. */
  label?: string;
  human?: 'accepted' | 'edited' | 'rejected' | 'regenerated';
  failureReason?: string;
}

/** POST /v1/outcomes response: the outcome row id and the served request it
 * attached to (cluster / strategy prefix / router version). */
export interface OutcomeReceipt {
  id: string;
  request_id: string;
  attached: { cluster: string | null; strategy: string | null; router_version: number | null };
}

class Completions {
  constructor(private readonly client: Potion) {}

  /**
   * Create a chat completion.
   *
   * `policy` (policy id or name) is sent as `X-Potion-Policy` and overrides
   * the client's `defaultPolicy` for this request only; the api key's bound
   * policy remains the server-side default when neither is set. Returns
   * {@link PotionChatCompletion} — or, for `stream: true`, the raw openai
   * stream (unwrapped; see README).
   */
  async create(
    params: PotionChatCompletionCreateParams,
    options?: PotionRequestOptions,
  ): Promise<PotionChatCompletion | unknown> {
    const { policy, ...body } = params;
    const effective = policy ?? this.client.defaultPolicy;
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (effective) headers['X-Potion-Policy'] = effective;
    try {
      const { data, response } = await this.client.openai.chat.completions
        .create(body as ChatCompletionCreateParams, { ...(options ?? {}), headers })
        .withResponse();
      if (params.stream) {
        // Streaming returns an async iterator of chunks; headers are still
        // available on the raw response but there is no single completion
        // object to wrap. Returned unwrapped (documented contract).
        return data;
      }
      return new PotionChatCompletion(data as ChatCompletion, response.headers);
    } catch (err) {
      if (err instanceof APIError) {
        throw mapError({
          statusCode: err.status,
          body: extractErrorBody(err),
          fallbackMessage: err.message,
        });
      }
      throw err;
    }
  }
}

class Chat {
  readonly completions: Completions;
  constructor(client: Potion) {
    this.completions = new Completions(client);
  }
}

/** Extract the OpenAI-shaped error envelope across openai>=4 versions
 * (`err.error` carries the INNER error object; `err.body` may carry the
 * full `{"error": {...}}` envelope). */
function extractErrorBody(err: APIError): PotionErrorBody | null {
  const raw = err as unknown as { error?: unknown; body?: unknown };
  if (isEnvelope(raw.error)) return raw.error;
  if (isEnvelope(raw.body)) return raw.body;
  if (raw.error && typeof raw.error === 'object') {
    return { error: raw.error as NonNullable<PotionErrorBody['error']> };
  }
  return null;
}

function isEnvelope(v: unknown): v is PotionErrorBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in v &&
    typeof (v as PotionErrorBody).error === 'object'
  );
}

/**
 * Potion gateway client.
 *
 * ```ts
 * const client = new Potion({
 *   baseUrl: 'http://localhost:3000',
 *   apiKey: 'pk_...',
 *   defaultPolicy: 'cheap',           // optional
 * });
 * const resp = await client.chat.completions.create({
 *   model: 'potion-auto',
 *   messages: [{ role: 'user', content: 'hello' }],
 * });
 * console.log(resp.choices[0].message.content, resp.frontierTrace, resp.cost);
 * ```
 */
export class Potion {
  /** The wrapped official client — escape hatch for every other resource
   * (models, embeddings, raw request options, …). */
  readonly openai: OpenAI;
  readonly defaultPolicy: string | undefined;
  readonly chat: Chat;

  constructor(options: PotionOptions) {
    const { baseUrl, apiKey, defaultPolicy, ...openaiOptions } = options;
    let base = baseUrl.replace(/\/+$/, '');
    if (!base.endsWith('/v1')) base = `${base}/v1`;
    this.openai = new OpenAI({ ...openaiOptions, baseURL: base, apiKey });
    this.defaultPolicy = defaultPolicy;
    this.chat = new Chat(this);
  }

  /** Convenience passthrough to `openai.models`. */
  get models(): OpenAI['models'] {
    return this.openai.models;
  }

  /** Convenience passthrough to `openai.embeddings`. */
  get embeddings(): OpenAI['embeddings'] {
    return this.openai.embeddings;
  }

  /**
   * G1 Outcome API: report what ACTUALLY happened after a served response —
   * `requestId` is the completion's `id`. Call it where your application
   * already knows the truth (tests ran, validator passed, a human accepted
   * or edited, the customer clicked regenerate):
   *
   * ```ts
   * const resp = await client.chat.completions.create({ ... });
   * // …later, when the generated SQL has run:
   * await client.outcome(resp.id, { success: true, validator: 'sql_executed' });
   * ```
   *
   * Outcomes are append-only — send a later signal (e.g. the human verdict)
   * as another call; the latest signal of each kind wins.
   */
  async outcome(requestId: string, signals: OutcomeSignals): Promise<OutcomeReceipt> {
    const { failureReason, ...rest } = signals;
    try {
      return (await this.openai.post('/outcomes', {
        body: {
          request_id: requestId,
          ...rest,
          ...(failureReason !== undefined ? { failure_reason: failureReason } : {}),
        },
      })) as OutcomeReceipt;
    } catch (err) {
      if (err instanceof APIError) {
        throw mapError({
          statusCode: err.status,
          body: extractErrorBody(err),
          fallbackMessage: err.message,
        });
      }
      throw err;
    }
  }
}
