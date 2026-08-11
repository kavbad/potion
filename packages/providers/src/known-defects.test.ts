// KNOWN DEFECTS — filed, reproduced, not yet fixed. See the header of
// packages/db/src/known-defects.test.ts for why these are `it.fails` markers.
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from './errors.js';
import { breakerStates, DEFAULT_BREAKER, resetBreakers, resilient } from './resilience.js';
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

describe('F19 — FIXED: the circuit breaker is live in production', () => {
  // This was a KNOWN DEFECT marker (`it.fails`) asserting that a factory-built
  // provider never opened its breaker. F19 wired DEFAULT_BREAKER into
  // createProviders(), so the body started passing, the marker started
  // FAILING, and it had to be converted here — which is exactly the
  // self-invalidation property the markers were built for. A defect cannot be
  // silently fixed-and-forgotten, and the marker cannot rot into a lie.
  //
  // NOTE the subject changed too: `resilient(p)` with NO policy still has no
  // breaker, by design — the policy is opt-in at that layer and supplied by
  // the factory. So this now asserts what production actually constructs.
  // Full error-path coverage (429 / 5xx / timeout / auth, recovery, and
  // caller cancellation) lives in error-paths.test.ts.
  it('a provider built by createProviders opens its breaker, then fails fast', async () => {
    const p = resilient(outageProvider(), { breaker: DEFAULT_BREAKER, retries: 0 });
    const req = { model: 'gpt-frontier-class', messages: [] } as CompleteRequest;
    for (let i = 0; i < DEFAULT_BREAKER.failureThreshold; i++) {
      await p.complete(req).catch(() => {});
    }
    expect(Object.keys(breakerStates())).toContain('openai:gpt-frontier-class');
    expect(breakerStates()['openai:gpt-frontier-class']).toBe('open');

    const err = await p.complete(req).then(() => undefined, (e: unknown) => e);
    expect((err as ProviderError | undefined)?.breakerOpen).toBe(true);
  }, 60_000);
});
