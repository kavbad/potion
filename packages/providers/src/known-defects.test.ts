// KNOWN DEFECTS — filed, reproduced, not yet fixed. See the header of
// packages/db/src/known-defects.test.ts for why these are `it.fails` markers.
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from './errors.js';
import { breakerStates, resetBreakers, resilient } from './resilience.js';
import type { CompleteRequest, CompleteResponse, Provider } from './types.js';

beforeEach(() => resetBreakers());

/** Always fails with a RETRYABLE kind — the shape a real 5xx outage takes. */
function outageProvider(id = 'openai'): Provider {
  return {
    id,
    async complete(_req: CompleteRequest): Promise<CompleteResponse> {
      throw new ProviderError(id, 'upstream 503', { kind: 'server_5xx' });
    },
  };
}

describe('KNOWN DEFECT F19: the circuit breaker is dead in production', () => {
  // `ResiliencePolicy.breaker` is OPTIONAL and "omitted = no breaker"
  // (resilience.ts:32). factory.ts:89-93 wraps every provider as
  // `resilient(p)` — no policy — so no breaker record is ever created and
  // `breakerStates()` is permanently {}. Hedging is dead by the same
  // omission (`hedgeAfterMs` is likewise never set).
  //
  // The phantom: docs/HA.md documents /readyz returning
  //   "breakers": { "openai:gpt-frontier-class": "open" }
  // as a live example of a state the running system cannot reach, and
  // /readyz reads that same permanently-empty registry. An operator
  // debugging an outage is told a protection exists that does not.
  //
  // Impact: during a provider outage every request pays the full retry
  // ladder (retries x per-attempt timeout) instead of failing fast, so an
  // upstream outage becomes a latency outage on our side. The seconds this
  // test spends in its loop ARE that cost, measured.
  it.fails(
    'a provider wrapped the way the factory wraps it opens its breaker, then fails fast',
    async () => {
      const p = resilient(outageProvider()); // EXACTLY factory.ts:89-93
      const req = { model: 'gpt-frontier-class', messages: [] } as CompleteRequest;
      for (let i = 0; i < 4; i++) await p.complete(req).catch(() => {});

      // 1. /readyz promises to surface this key. The registry is empty.
      expect(Object.keys(breakerStates())).toContain('openai:gpt-frontier-class');
      expect(breakerStates()['openai:gpt-frontier-class']).toBe('open');

      // 2. …and an open breaker must short-circuit the next call.
      const err = await p.complete(req).then(() => undefined, (e: unknown) => e);
      expect((err as ProviderError | undefined)?.breakerOpen).toBe(true);
    },
    60_000,
  );
});
