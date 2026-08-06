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
import { resilient } from './resilience.js';

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
const ENV_VAR_BY_PROVIDER: Record<Exclude<ProviderId, 'mock'>, string> = {
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
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
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

export function createProviders(opts: ProviderFactoryOptions): Record<ProviderId, Provider> {
  // SPEC §12.1: every provider is wrapped with `resilient` defaults (3 retries,
  // full-jitter backoff 250→8000ms, 60s per-attempt timeout; no breaker, no
  // hedging). Successful calls pass through untouched, so mock determinism
  // (SPEC §2) is fully preserved.
  return {
    mock: resilient(createMockProvider(opts.prices)),
    anthropic: resilient(lazyLiveProvider('anthropic', opts)),
    openai: resilient(lazyLiveProvider('openai', opts)),
    google: resilient(lazyLiveProvider('google', opts)),
    openrouter: resilient(lazyLiveProvider('openrouter', opts)),
  };
}
