// Shared retry/timeout wrapper for all live provider transports (SPEC §2).
// - Exponential backoff: 250ms base, ×2 per attempt, ±20% jitter.
// - Retries ONLY on HTTP 429, HTTP 5xx, and network errors (fetch throw).
//   Never retries other 4xx (401/403 → ProviderAuthError immediately).
// - Per-attempt timeout via AbortController (default 60s) → ProviderTimeoutError.
// Raw `fetch` only — no vendor SDKs. Tests inject fetch/sleep/jitter (no network).
import type { ProviderId } from '@potion/core';
import {
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors.js';

export interface RetryOptions {
  /** Retries after the initial attempt (total attempts = 1 + maxRetries). Default 3. */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /** Backoff base in ms (doubles each retry). Default 250. */
  baseDelayMs?: number;
  /** Jitter fraction (±). Default 0.2. */
  jitter?: number;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable random source in [0,1) for jitter; defaults to Math.random. */
  rand?: () => number;
}

export interface HttpJsonRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /**
   * F19: the CALLER's cancellation signal (CompleteRequest.signal), linked to
   * this attempt's own timeout controller.
   *
   * Before F19 the live transports created a controller and discarded the
   * caller's signal entirely, so an aborted call kept running at the provider
   * — and kept being billed. That was latent while hedging was off (nothing
   * aborted anything), but it is also the precondition for ever turning
   * hedging on: a hedge that cannot cancel its loser is a duplicate purchase,
   * not an optimization.
   */
  signal?: AbortSignal | undefined;
}

export interface HttpJsonResponse<T> {
  status: number;
  json: T;
}

/** Sentinel distinguishing "body failed to parse" from every legal JSON
 * value (JSON encodes null but never undefined; a symbol collides with
 * neither). Error-path parsing keeps flowing undefined into
 * errorBodyMessage, byte-compatible with the previous behavior. */
const PARSE_FAILED: unique symbol = Symbol('json-parse-failed');

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_JITTER = 0.2;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff delay before retry `attempt` (1-based): base × 2^(attempt-1), ± jitter. */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
  jitter: number = DEFAULT_JITTER,
  rand: () => number = Math.random,
): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const factor = 1 + jitter * (2 * rand() - 1); // in [1-jitter, 1+jitter)
  return Math.round(exponential * factor);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Extract a short error message from a provider error body, best-effort. */
export function errorBodyMessage(json: unknown): string {
  if (json !== null && typeof json === 'object') {
    const err = (json as { error?: unknown }).error;
    if (typeof err === 'string') return err;
    if (err !== null && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string') return msg;
    }
    const msg = (json as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return '';
}

/**
 * POST a JSON body with retry + per-attempt timeout. Parses the response as
 * JSON regardless of status. Throws typed ProviderError subclasses; never
 * throws raw fetch/HTTP errors.
 */
export async function postJsonWithRetry<T = unknown>(
  provider: ProviderId,
  req: HttpJsonRequest,
  opts: RetryOptions = {},
): Promise<HttpJsonResponse<T>> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const jitter = opts.jitter ?? DEFAULT_JITTER;
  const fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const sleep = opts.sleep ?? defaultSleep;
  const rand = opts.rand ?? Math.random;

  let rateLimitedAttempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelayMs(attempt, baseDelayMs, jitter, rand));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Caller abort propagates to this attempt. Registered per attempt and
    // torn down in the same finally as the timer, so a long-lived caller
    // signal never accumulates listeners across retries.
    const onCallerAbort = (): void => controller.abort();
    req.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (req.signal?.aborted === true) controller.abort();
    let res: Response;
    try {
      res = await fetchFn(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ProviderTimeoutError(provider, timeoutMs, { cause: err });
      }
      // Network error (DNS, reset, TLS, …): retryable.
      if (attempt < maxRetries) continue;
      throw new ProviderError(
        provider,
        `provider '${provider}': network error after ${maxRetries} retries: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err, kind: 'network' },
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onCallerAbort);
    }

    const parsed: unknown = await res.json().catch(() => PARSE_FAILED);
    if (res.ok) {
      if (parsed !== PARSE_FAILED) return { status: res.status, json: parsed as T };
      // 2xx whose body strict JSON parsing rejects (seen live 2026-08-20: an
      // OpenRouter gemini-2.5-pro body carrying a RAW control character).
      // Returning undefined here made the transport's caller throw an untyped
      // TypeError on `json.choices` — one corrupt byte read as a code bug.
      // The body is corrupt in transit-or-serialization terms, so it retries
      // like a network fault and surfaces typed when it persists.
      if (attempt < maxRetries) continue;
      throw new ProviderError(
        provider,
        `provider '${provider}': HTTP ${res.status} body failed JSON parsing after ${maxRetries} retries`,
        { status: res.status, kind: 'network' },
      );
    }
    const json = (parsed === PARSE_FAILED ? undefined : parsed) as T;

    const detail = errorBodyMessage(json);
    const suffix = detail ? `: ${detail}` : ` (HTTP ${res.status})`;

    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError(provider, `provider '${provider}': authentication failed${suffix}`, {
        status: res.status,
      });
    }
    if (res.status === 429) {
      rateLimitedAttempts++;
      if (attempt < maxRetries) continue;
      throw new ProviderRateLimitError(
        provider,
        `provider '${provider}': rate limited (429) after ${rateLimitedAttempts} attempts${suffix}`,
        rateLimitedAttempts,
        { status: res.status },
      );
    }
    if (isRetryableStatus(res.status)) {
      if (attempt < maxRetries) continue;
      throw new ProviderError(
        provider,
        `provider '${provider}': server error persisted after ${maxRetries} retries${suffix}`,
        { status: res.status },
      );
    }
    // Other 4xx: never retried.
    throw new ProviderError(provider, `provider '${provider}': request failed${suffix}`, {
      status: res.status,
    });
  }
  // Unreachable: the loop always returns or throws.
  throw new ProviderError(provider, `provider '${provider}': exhausted retries`);
}
