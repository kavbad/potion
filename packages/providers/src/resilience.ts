// Provider resilience (SPEC §12.1): retry w/ full-jitter exponential backoff,
// per-attempt timeout, optional per-(provider,model) circuit breaker, optional
// hedging, failover chains, and a deterministic seeded chaos provider.
//
// Safety invariants:
// - Error messages NEVER include request headers or key material: raw
//   underlying error messages are attached as `cause`, never interpolated.
// - Mock determinism survives: a successful call passes through untouched;
//   jitter only affects retry sleep durations.

import type { ProviderId } from '@potion/core';
import { ProviderError, classifyError, type ProviderErrorKind } from './errors.js';
import type { CompleteRequest, CompleteResponse, Provider } from './types.js';
import { mulberry32, seedOf } from './mock/rng.js';
import { MOCK_WORDS } from './mock/fixtures.js';
import { latencyProfileMs } from './mock/mock.js';

// ---------------------------------------------------------------------------
// Policy types (SPEC §12.1)
// ---------------------------------------------------------------------------

export interface BreakerPolicy {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenProbes: number;
}

export interface ResiliencePolicy {
  retries: number; // retryable errors only; default 3
  backoff: { baseMs: number; maxMs: number; jitter: 'full' | 'none' }; // default 250/8000/full
  timeoutMs: number; // per-attempt; default 60_000
  breaker?: BreakerPolicy; // per (provider,model); omitted = no breaker
  hedgeAfterMs?: number; // duplicate in-flight call after N ms, first result wins, loser aborted
}

export type BreakerState = 'closed' | 'open' | 'half-open';

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 60_000;

interface ResolvedPolicy {
  retries: number;
  backoff: { baseMs: number; maxMs: number; jitter: 'full' | 'none' };
  timeoutMs: number;
  breaker?: BreakerPolicy;
  hedgeAfterMs?: number;
}

function resolvePolicy(policy?: Partial<ResiliencePolicy>): ResolvedPolicy {
  const out: ResolvedPolicy = {
    retries: policy?.retries ?? DEFAULT_RETRIES,
    backoff: {
      baseMs: policy?.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
      maxMs: policy?.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS,
      jitter: policy?.backoff?.jitter ?? 'full',
    },
    timeoutMs: policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (policy?.breaker !== undefined) out.breaker = policy.breaker;
  if (policy?.hedgeAfterMs !== undefined) out.hedgeAfterMs = policy.hedgeAfterMs;
  return out;
}

/** Full-jitter (or jitter-free) exponential backoff before retry `attempt` (1-based). */
export function resilienceBackoffMs(
  attempt: number,
  backoff: ResolvedPolicy['backoff'],
  rand: () => number = Math.random,
): number {
  const cap = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (attempt - 1));
  if (backoff.jitter === 'none') return cap;
  return Math.floor(rand() * (cap + 1)); // full jitter: uniform in [0, cap]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

// ---------------------------------------------------------------------------
// Circuit breaker registry (SPEC §12.1 metrics hook)
// ---------------------------------------------------------------------------

interface BreakerRecord {
  state: BreakerState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  probesInFlight: number;
  openedAt: number;
  policy: BreakerPolicy;
}

const BREAKERS = new Map<string, BreakerRecord>();

/** Snapshot of every breaker keyed `${providerId}:${model}` (metrics hook). */
export function breakerStates(): Record<string, BreakerState> {
  const out: Record<string, BreakerState> = {};
  for (const [key, rec] of BREAKERS) out[key] = rec.state;
  return out;
}

/** Test hook: clear the breaker registry. */
export function resetBreakers(): void {
  BREAKERS.clear();
}

function breakerRecord(key: string, policy: BreakerPolicy): BreakerRecord {
  let rec = BREAKERS.get(key);
  if (!rec) {
    rec = {
      state: 'closed',
      consecutiveFailures: 0,
      halfOpenSuccesses: 0,
      probesInFlight: 0,
      openedAt: 0,
      policy,
    };
    BREAKERS.set(key, rec);
  }
  return rec;
}

function breakerOpenError(provider: ProviderId, model: string): ProviderError {
  return new ProviderError(
    provider,
    `provider '${provider}': circuit breaker open for '${provider}:${model}' — failing fast`,
    { kind: 'unknown', model, breakerOpen: true },
  );
}

/**
 * Gate executed BEFORE a call. Returns true when the call may proceed.
 * Throws a fast-reject ProviderError when the breaker is open (and cooling
 * down) or saturated with half-open probes.
 */
function breakerBeforeCall(rec: BreakerRecord, provider: ProviderId, model: string): void {
  if (rec.state === 'open') {
    if (Date.now() - rec.openedAt >= rec.policy.cooldownMs) {
      rec.state = 'half-open';
      rec.halfOpenSuccesses = 0;
      rec.probesInFlight = 0;
    } else {
      throw breakerOpenError(provider, model);
    }
  }
  if (rec.state === 'half-open') {
    if (rec.probesInFlight >= rec.policy.halfOpenProbes) {
      throw breakerOpenError(provider, model);
    }
    rec.probesInFlight++;
  }
}

function breakerOnSuccess(rec: BreakerRecord): void {
  if (rec.state === 'half-open') {
    rec.probesInFlight = Math.max(0, rec.probesInFlight - 1);
    rec.halfOpenSuccesses++;
    if (rec.halfOpenSuccesses >= rec.policy.halfOpenProbes) {
      rec.state = 'closed';
      rec.consecutiveFailures = 0;
      rec.halfOpenSuccesses = 0;
    }
  } else {
    rec.consecutiveFailures = 0;
  }
}

function breakerOnFailure(rec: BreakerRecord): void {
  if (rec.state === 'half-open') {
    rec.probesInFlight = Math.max(0, rec.probesInFlight - 1);
    rec.state = 'open';
    rec.openedAt = Date.now();
    rec.halfOpenSuccesses = 0;
    return;
  }
  rec.consecutiveFailures++;
  if (rec.consecutiveFailures >= rec.policy.failureThreshold) {
    rec.state = 'open';
    rec.openedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Per-attempt execution: timeout + hedging
// ---------------------------------------------------------------------------

/**
 * One provider call bounded by a per-attempt timeout. The attempt's
 * AbortController signal is threaded into the request (providers may ignore
 * it; chaosProvider honors it). On timeout the attempt rejects with a
 * retryable 'timeout' ProviderError; on external abort (hedge loser) it
 * rejects with an AbortError.
 */
function callWithTimeout(
  p: Provider,
  req: CompleteRequest,
  timeoutMs: number,
  controller: AbortController,
): Promise<CompleteResponse> {
  return new Promise<CompleteResponse>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      // Reject FIRST so the abort listener below cannot win the race and
      // mask the timeout kind.
      reject(
        new ProviderError(
          p.id,
          `provider '${p.id}': request timed out after ${timeoutMs}ms`,
          { kind: 'timeout', model: req.model },
        ),
      );
      controller.abort();
    }, timeoutMs);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      fn();
    };
    p.complete({ ...req, signal: controller.signal }).then(
      (res) => done(() => resolve(res)),
      (err) => done(() => reject(err)),
    );
  });
}

/**
 * One resilience attempt: a single call, or — when `hedgeAfterMs` is set — a
 * race between the primary call and a duplicate started after the delay.
 * First success wins; the loser is aborted (AbortError) and its usage is
 * discarded. The winner's response is returned untouched, plus `hedged: true`
 * when a duplicate was actually started.
 */
function attemptCall(
  p: Provider,
  req: CompleteRequest,
  policy: ResolvedPolicy,
): Promise<CompleteResponse> {
  if (policy.hedgeAfterMs === undefined) {
    return callWithTimeout(p, req, policy.timeoutMs, new AbortController());
  }
  const hedgeAfterMs = policy.hedgeAfterMs;
  return new Promise<CompleteResponse>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let started = 0;
    let failures = 0;
    let firstErr: unknown;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const startCall = (): void => {
      started++;
      const controller = new AbortController();
      controllers.push(controller);
      callWithTimeout(p, req, policy.timeoutMs, controller).then(
        (res) => {
          if (settled) return;
          settled = true;
          if (hedgeTimer !== undefined) clearTimeout(hedgeTimer);
          for (const c of controllers) c.abort(); // abort the loser(s)
          resolve(started > 1 ? { ...res, hedged: true } : res);
        },
        (err: unknown) => {
          firstErr ??= err;
          failures++;
          const hedgePending = hedgeTimer !== undefined;
          if (!settled && !hedgePending && failures >= started) {
            settled = true;
            reject(firstErr);
          }
        },
      );
    };

    startCall();
    hedgeTimer = setTimeout(() => {
      hedgeTimer = undefined;
      if (!settled) startCall();
    }, hedgeAfterMs);
  });
}

// ---------------------------------------------------------------------------
// resilient() wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a provider with retry (full-jitter exponential backoff), per-attempt
 * timeout, and optional circuit breaker / hedging (SPEC §12.1).
 * Only retryable kinds (rate_limit | timeout | server_5xx | network) are
 * retried; client_4xx (except 429) fails immediately.
 */
export function resilient(p: Provider, policy?: Partial<ResiliencePolicy>): Provider {
  const resolved = resolvePolicy(policy);

  const wrapped: Provider = {
    id: p.id,

    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const key = `${p.id}:${req.model}`;
      const rec = resolved.breaker ? breakerRecord(key, resolved.breaker) : undefined;

      let lastErr: ProviderError | undefined;
      for (let attempt = 0; attempt <= resolved.retries; attempt++) {
        if (attempt > 0) {
          await sleep(resilienceBackoffMs(attempt, resolved.backoff));
        }
        try {
          if (rec) breakerBeforeCall(rec, p.id, req.model);
          const res = await attemptCall(p, req, resolved);
          if (rec) breakerOnSuccess(rec);
          return res;
        } catch (err) {
          const pErr = asProviderError(err, p.id, req.model);
          if (rec && !pErr.breakerOpen) breakerOnFailure(rec);
          // Breaker fast-rejects are not retried inside this wrapper (the
          // breaker state will not change within one call).
          if (pErr.breakerOpen) throw pErr;
          lastErr = pErr;
          if (!pErr.retryable || attempt >= resolved.retries) throw pErr;
        }
      }
      // Unreachable (loop always returns/throws), kept for the type checker.
      throw lastErr ?? new ProviderError(p.id, `provider '${p.id}': exhausted retries`);
    },
  };

  // Embeddings pass through untouched: §12.1 defines retry semantics for
  // complete() only, and embed must stay deterministic for the mock.
  if (p.embed) {
    const embed = p.embed.bind(p);
    wrapped.embed = (texts) => embed(texts);
  }
  return wrapped;
}

/**
 * Normalize any thrown value to a ProviderError. Raw messages from
 * NON-ProviderError throws are NEVER interpolated (they may echo request
 * material); they are preserved on `cause` only.
 */
function asProviderError(err: unknown, provider: ProviderId, model: string): ProviderError {
  // ProviderError instances (incl. subclasses like ProviderAuthError) pass
  // through with identity intact — callers rely on `instanceof`.
  if (err instanceof ProviderError) return err;
  const kind = classifyError(err);
  return new ProviderError(provider, `provider '${provider}': call failed (${kind})`, {
    kind,
    model,
    cause: err,
  });
}

// ---------------------------------------------------------------------------
// failoverChain()
// ---------------------------------------------------------------------------

/**
 * Try providers in order (SPEC §12.1): each is wrapped with `resilient`
 * using the same policy; the next provider is tried when the current one
 * exhausts its retries on a retryable error or its breaker is open.
 * Non-retryable errors (client_4xx, unknown) propagate immediately.
 */
export function failoverChain(
  providers: Provider[],
  policy?: Partial<ResiliencePolicy>,
): Provider {
  if (providers.length === 0) {
    throw new Error('failoverChain: at least one provider is required');
  }
  const wrapped = providers.map((p) => resilient(p, policy));
  const first = providers[0]!;

  const chain: Provider = {
    id: first.id,

    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      let lastErr: unknown;
      for (const p of wrapped) {
        try {
          return await p.complete(req);
        } catch (err) {
          lastErr = err;
          const pErr = asProviderError(err, p.id, req.model);
          if (pErr.retryable || pErr.breakerOpen === true) continue;
          throw pErr;
        }
      }
      throw lastErr;
    },
  };

  if (first.embed) {
    const embed = first.embed.bind(first);
    chain.embed = (texts) => embed(texts);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// chaosProvider() — deterministic seeded fault injection (mock-only)
// ---------------------------------------------------------------------------

/** Representative HTTP status for injected kinds (when one exists). */
function statusForKind(kind: ProviderErrorKind): number | undefined {
  switch (kind) {
    case 'rate_limit':
      return 429;
    case 'server_5xx':
      return 500;
    case 'client_4xx':
      return 400;
    default:
      return undefined; // timeout / network / unknown have no HTTP status
  }
}

const DEFAULT_CHAOS_KINDS: ProviderErrorKind[] = [
  'rate_limit',
  'timeout',
  'server_5xx',
  'network',
];

/**
 * Deterministic seeded fault-injection provider (SPEC §12.1). Mock-only
 * (id 'mock'). Each complete() call draws from a seeded mulberry32 stream:
 * roll < failRate → throw a ProviderError of a drawn kind (same sequence for
 * the same seed and call order); otherwise return a deterministic mock-style
 * response. `hangMs` makes successful calls hang until the attempt signal is
 * aborted (or the hang elapses) — for timeout/hedge tests.
 */
export function chaosProvider(opts: {
  failRate: number;
  kinds?: ProviderErrorKind[];
  hangMs?: number;
  seed?: number;
}): Provider {
  const rng = mulberry32(opts.seed ?? 1);
  const kinds = opts.kinds ?? DEFAULT_CHAOS_KINDS;

  return {
    id: 'mock',

    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      if (rng() < opts.failRate) {
        const kind = kinds[Math.floor(rng() * kinds.length)] ?? 'server_5xx';
        const status = statusForKind(kind);
        throw new ProviderError('mock', `provider 'mock': chaos-injected ${kind} failure`, {
          kind,
          model: req.model,
          ...(status !== undefined ? { status } : {}),
        });
      }
      if (opts.hangMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          if (req.signal?.aborted) {
            reject(abortError());
            return;
          }
          const timer = setTimeout(() => {
            req.signal?.removeEventListener('abort', onAbort);
            resolve();
          }, opts.hangMs);
          const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortError());
          };
          req.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      // Deterministic mock-style success: same word-bank derivation as the
      // mock provider (seeded by params.seed ?? hash(prompt)), $0 usage.
      const promptText = req.messages.map((m) => `${m.role}:${m.content}`).join('\n');
      const textRng = mulberry32(seedOf(req.params?.seed, promptText));
      const wordCount = 12 + Math.floor(textRng() * 24);
      const words: string[] = [];
      for (let i = 0; i < wordCount; i++) {
        words.push(MOCK_WORDS[Math.floor(textRng() * MOCK_WORDS.length)] ?? 'word');
      }
      const text = `[mock:${req.model}] ${words.join(' ')}.`;
      return {
        text,
        usage: {
          inputTokens: Math.ceil(promptText.length / 4),
          outputTokens: Math.ceil(text.length / 4),
        },
        latencyMs: latencyProfileMs(req.model),
        modelVersion: `${req.model}#mock-v1`,
      };
    },
  };
}
