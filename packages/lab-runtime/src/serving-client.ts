// The ONE outbound module (touchpoint 1). Every model call the runtime makes
// goes through here, over HTTP, against the serving route — the actual
// chokepoints (budget hard stop, rate limiter, per-call metering, breaker),
// never an in-process shortcut. The route IS the contract.
//
// 'potion-auto' is the documented model label (openai-parity.ts:81,
// dashboard.ts:122): serving routes by cluster + the key's policy; the label
// is a client convention, not a selection.
import type { ChatMessage, Tool, ToolCall, ToolChoice } from '@potion/core';

export interface ServingClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  /** Lab Step 7 (touchpoint 2, additive): ride serving's EXISTING
   * per-request pins on every call this client makes. `policyRef` becomes
   * X-Potion-Policy (an org policy id or name — the dial's materialized
   * row); `clusterHint` becomes X-Potion-Cluster. Serving resolves,
   * records, and echoes both on x-frontier-trace; unknown refs are
   * serving's documented 400s, surfaced as ServingResult errors. */
  policyRef?: string;
  clusterHint?: string;
}

export interface ServingRequest {
  messages: ChatMessage[];
  tools?: Tool[] | undefined;
  toolChoice?: ToolChoice | undefined;
  signal?: AbortSignal | undefined;
}

export type ServingResult =
  | {
      kind: 'ok';
      completionId: string;
      text: string;
      toolCalls: ToolCall[];
      finishReason: string;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      /** x-frontier-trace, verbatim — per-step provenance as served. */
      frontierTrace: string;
    }
  | { kind: 'budget-exceeded'; detail: string }
  | { kind: 'rate-limited'; retryAfterMs: number; detail: string }
  | { kind: 'error'; status: number; code: string; detail: string };

interface OpenAiErrorBody {
  error?: { message?: string; code?: string; type?: string };
}

export class ServingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly pinHeaders: Record<string, string>;

  constructor(opts: ServingClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.pinHeaders = {
      ...(opts.policyRef !== undefined ? { 'x-potion-policy': opts.policyRef } : {}),
      ...(opts.clusterHint !== undefined ? { 'x-potion-cluster': opts.clusterHint } : {}),
    };
  }

  async complete(req: ServingRequest): Promise<ServingResult> {
    const body: Record<string, unknown> = {
      model: 'potion-auto',
      messages: req.messages,
      ...(req.tools !== undefined ? { tools: req.tools } : {}),
      ...(req.toolChoice !== undefined ? { tool_choice: req.toolChoice } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.pinHeaders,
        },
        body: JSON.stringify(body),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
    } catch (e) {
      return { kind: 'error', status: 0, code: 'network', detail: (e as Error).message };
    }

    if (res.status === 429) {
      const parsed = (await res.json().catch(() => ({}))) as OpenAiErrorBody;
      const code = parsed.error?.code ?? '';
      const detail = parsed.error?.message ?? '429';
      // budget_exceeded (budgets.ts) is the HARD STOP — terminal for the run,
      // never retried (F10: re-running against a spent budget is how
      // double-spend incidents start). rate_limit_exceeded (ratelimit.ts) is
      // transient — retry with backoff honoring retry-after.
      if (code === 'budget_exceeded') return { kind: 'budget-exceeded', detail };
      const retryAfterSec = Number(res.headers.get('retry-after') ?? '1');
      return {
        kind: 'rate-limited',
        retryAfterMs: (Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000,
        detail,
      };
    }
    if (!res.ok) {
      const parsed = (await res.json().catch(() => ({}))) as OpenAiErrorBody;
      return {
        kind: 'error',
        status: res.status,
        code: parsed.error?.code ?? parsed.error?.type ?? String(res.status),
        detail: parsed.error?.message ?? `HTTP ${res.status}`,
      };
    }

    const frontierTrace = res.headers.get('x-frontier-trace') ?? '';
    const json = (await res.json()) as {
      id: string;
      choices: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const choice = json.choices[0];
    return {
      kind: 'ok',
      completionId: json.id,
      text: choice?.message?.content ?? '',
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? 'stop',
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      },
      frontierTrace,
    };
  }

  /** Span emission (the A3 adapter): POST /v1/traces, idempotent on
   * (org, trace, span), so re-emission after a crash is safe. */
  async emitSpans(spans: Array<Record<string, unknown>>): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/traces`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.pinHeaders,
        },
        body: JSON.stringify({ spans }),
      });
      return res.ok;
    } catch {
      return false; // span loss is never worth failing a run over
    }
  }
}
