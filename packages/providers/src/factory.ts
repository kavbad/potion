// Provider factory (SPEC §2): returns the mock provider plus the four live
// transports. Import NEVER throws and NEVER requires keys — live providers
// are constructed lazily and a missing key only fails on first call with a
// clear ProviderAuthError.
import type { ProviderId } from '@potion/core';
import type { Provider, ProviderFactoryOptions } from './types.js';
import { createMockProvider } from './mock/mock.js';
import { ProviderAuthError } from './errors.js';
import { createAnthropicProvider } from './live/anthropic.js';
import { createOpenAiProvider } from './live/openai.js';
import { createGoogleProvider } from './live/google.js';
import { createOpenRouterProvider } from './live/openrouter.js';
import type { LiveProviderOptions } from './live/common.js';
import { DEFAULT_BREAKER, resilient, type BreakerPolicy } from './resilience.js';

type LiveFactory = (opts: LiveProviderOptions) => Provider;

const LIVE_FACTORIES: Record<Exclude<ProviderId, 'mock'>, LiveFactory> = {
  anthropic: createAnthropicProvider,
  openai: createOpenAiProvider,
  google: createGoogleProvider,
  openrouter: createOpenRouterProvider,
};

/** Env-var fallback per provider (the error message below has always promised
 * this; explicit opts.apiKeys still wins). Read lazily at first call, not at
 * import, so tests can set/unset env freely. */
/** Env var per live provider (exported for G1.7 key-availability
 * preflights — a live sweep must pick class representatives whose
 * providers are actually reachable, m1b-sweep precedent). */
export const ENV_VAR_BY_PROVIDER: Record<Exclude<ProviderId, 'mock'>, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Providers with a live `embed` in v1 (see live/*.ts header comments). */
const HAS_EMBED: ReadonlySet<ProviderId> = new Set<ProviderId>(['mock', 'openai', 'google']);

/**
 * Lazy live provider: construction is free and never validates the key.
 * Without a key, every method throws ProviderAuthError on FIRST CALL (not
 * import); with a key, the real transport is constructed on first use.
 */
function lazyLiveProvider(id: Exclude<ProviderId, 'mock'>, opts: ProviderFactoryOptions): Provider {
  let real: Provider | undefined;
  const requireReal = (): Provider => {
    const apiKey = opts.apiKeys?.[id] ?? process.env[ENV_VAR_BY_PROVIDER[id]];
    if (!apiKey) {
      throw new ProviderAuthError(
        id,
        `provider '${id}': no API key for '${id}' — pass apiKeys.${id} to createProviders ` +
          `(or set the matching *_API_KEY env var); use the mock provider until then`,
      );
    }
    real ??= LIVE_FACTORIES[id]({
      apiKey,
      prices: opts.prices,
      ...(resolveTimeoutMs(opts.timeoutMs) !== undefined
        ? { timeoutMs: resolveTimeoutMs(opts.timeoutMs)! }
        : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    });
    return real;
  };

  const provider: Provider = {
    id,
    // async so a missing key surfaces as a REJECTED promise, not a sync throw.
    complete: async (req) => requireReal().complete(req),
  };
  // Anthropic/OpenRouter have no embed (live/*.ts); for embed-capable
  // providers without a key, embed throws the same first-call auth error.
  if (HAS_EMBED.has(id)) {
    provider.embed = async (texts) => {
      const r = requireReal();
      if (!r.embed) throw new ProviderAuthError(id, `provider '${id}': embed unavailable`);
      return r.embed(texts);
    };
  }
  return provider;
}

/**
 * F19: resolve the breaker policy from the environment.
 *
 * `POTION_BREAKER=off` disables it entirely (back to the pre-F19 behavior) —
 * an escape hatch for an operator who finds it opening spuriously, so the
 * remedy is a config change rather than a redeploy of patched code.
 */
export function breakerPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): BreakerPolicy | undefined {
  if (env.POTION_BREAKER === 'off' || env.POTION_BREAKER === '0') return undefined;
  const int = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    failureThreshold: int(env.POTION_BREAKER_THRESHOLD, DEFAULT_BREAKER.failureThreshold),
    cooldownMs: int(env.POTION_BREAKER_COOLDOWN_MS, DEFAULT_BREAKER.cooldownMs),
    halfOpenProbes: int(env.POTION_BREAKER_PROBES, DEFAULT_BREAKER.halfOpenProbes),
  };
}

/**
 * Per-attempt provider timeout, with an env override.
 *
 * The 60s default is right for SERVING, where a request nobody is waiting on
 * is a request that has already failed. It is wrong for an evaluation sweep:
 * a 1600-token generation from a slow model legitimately exceeds it, and a
 * measured campaign should be allowed to wait for an answer it is paying for.
 *
 * Found the hard way — the 23-model tranche sweep failed five legs on
 * "request timed out after 60000ms" while a probe showed every model
 * answering fine at 8 tokens. The cost of the wrong default here is a whole
 * leg's spend for no evidence, so it is a knob rather than a constant.
 *
 * An explicit `opts.timeoutMs` always wins; the env var only supplies a
 * default, so nothing that already sets it changes behaviour.
 */
export function resolveTimeoutMs(explicit?: number): number | undefined {
  if (explicit !== undefined) return explicit;
  const raw = process.env.POTION_PROVIDER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createProviders(opts: ProviderFactoryOptions): Record<ProviderId, Provider> {
  // SPEC §12.1: every provider is wrapped with `resilient` defaults (3 retries,
  // full-jitter backoff 250→8000ms, 60s per-attempt timeout) PLUS, since F19,
  // a real circuit breaker (DEFAULT_BREAKER, POTION_BREAKER=off to disable).
  // Successful calls pass through untouched, so mock determinism (SPEC §2) is
  // fully preserved.
  //
  // HEDGING REMAINS OFF, deliberately. `hedgeAfterMs` starts a duplicate call
  // and aborts the loser through `req.signal`; until every live transport
  // honors that signal (it now does — see http.ts), a hedged request would
  // keep paying for the loser at the provider. Turning it on is a spend
  // decision, not a resilience default, and stays filed.
  const breaker = opts.breaker === undefined ? breakerPolicyFromEnv() : (opts.breaker ?? undefined);
  // THE 60s CLAMP NOBODY DECLARED — the timeout bug's second instance, and
  // the subtler one. resolveTimeoutMs correctly threads the declared timeout
  // into the HTTP transport, but `resilient` wraps that transport with its
  // OWN per-attempt timeout, and this policy never carried one — so the
  // wrapper clamped every attempt at its 60_000 default while the transport
  // underneath was honestly configured for 180s. The original live probe
  // (1200ms) "proved" the plumbing precisely because 1200 < 60000: the inner
  // timeout fired first and masked the outer clamp. Any attempt needing
  // 60–180s died at 60 with a message blaming the provider.
  //
  // The wrapper's timeout gets the declared value PLUS headroom, so the
  // transport's abort — the layer that accounts the attempt correctly — is
  // always the one that fires; the resilience timeout returns to being what
  // it was meant to be, a backstop against a hung transport.
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const policy = {
    ...(breaker === undefined ? {} : { breaker }),
    ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs + 5_000 } : {}),
  };
  return {
    mock: resilient(createMockProvider(opts.prices), policy),
    anthropic: resilient(lazyLiveProvider('anthropic', opts), policy),
    openai: resilient(lazyLiveProvider('openai', opts), policy),
    google: resilient(lazyLiveProvider('google', opts), policy),
    openrouter: resilient(lazyLiveProvider('openrouter', opts), policy),
  };
}
