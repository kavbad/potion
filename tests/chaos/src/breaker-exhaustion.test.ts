// Chaos: circuit-breaker exhaustion (ROADMAP #29, SPEC §12.9).
//
// chaosProvider(failRate=1) behind resilient() with a breaker policy. TRUE
// BEHAVIOR (documented, tested here):
//   · After `failureThreshold` consecutive exhausted calls the breaker OPENS.
//   · While open, requests FAIL FAST — a breakerOpen ProviderError with NO
//     retry/backoff sleep (elapsed << the retry budget of a real attempt).
//   · breakerStates() reports the open breaker, and the /readyz payload
//     reflects it (the readiness report always carries the breaker summary,
//     SPEC §12.8) — 200 stays 200 because db+queue probes still pass; the
//     breaker summary is informational, matching readiness.ts semantics.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderError,
  breakerStates,
  chaosProvider,
  resilient,
  resetBreakers,
} from '@potion/providers';
import { buildServer } from '@potion/server/server';

const MODEL = 'chaos-breaker-model';
const KEY = `mock:${MODEL}`;
// The breaker counts failed ATTEMPTS (resilient() calls breakerOnFailure per
// retry). With retries:2 one complete() costs up to 3 failures, so a
// threshold of 4 keeps the first call closed and trips mid-second-call.
const BREAKER = { failureThreshold: 4, cooldownMs: 60_000, halfOpenProbes: 1 };

const REQ = {
  model: MODEL,
  messages: [{ role: 'user' as const, content: 'chaos breaker probe' }],
};

function deadProvider() {
  return resilient(chaosProvider({ failRate: 1, kinds: ['server_5xx'], seed: 99 }), {
    retries: 2,
    backoff: { baseMs: 250, maxMs: 1_000, jitter: 'none' },
    timeoutMs: 5_000,
    breaker: BREAKER,
  });
}

describe('chaos: breaker exhaustion', () => {
  beforeAll(() => resetBreakers());
  afterAll(() => resetBreakers());

  it('breaker opens after exhaustion; requests then fail fast (elapsed << retry budget)', async () => {
    const p = deadProvider();

    // One real attempt measures the retry budget (2 retries × 250/500ms).
    const t0 = Date.now();
    const firstErr = await p.complete(REQ).then(
      () => null,
      (e: unknown) => e,
    );
    const retryBudgetMs = Date.now() - t0;
    expect(firstErr).toBeInstanceOf(ProviderError);
    expect(retryBudgetMs).toBeGreaterThan(500); // backoff actually happened
    expect(breakerStates()[KEY]).toBe('closed'); // 3 failed attempts < threshold 4

    // Second call trips the breaker on its first attempt (failure #4), then
    // the remaining attempts fast-reject — the whole call is far cheaper than
    // the retry budget of the first.
    const t1b = Date.now();
    const secondErr = await p.complete(REQ).then(
      () => null,
      (e: unknown) => e,
    );
    const secondMs = Date.now() - t1b;
    expect(secondErr).toBeInstanceOf(ProviderError);
    expect(secondMs).toBeLessThan(retryBudgetMs);
    expect(breakerStates()[KEY]).toBe('open');

    // Open breaker → fail FAST: no retries, no backoff.
    const t1 = Date.now();
    const fastErr = await p.complete(REQ).then(
      () => null,
      (e: unknown) => e,
    );
    const fastMs = Date.now() - t1;
    expect(fastErr).toBeInstanceOf(ProviderError);
    expect((fastErr as ProviderError).breakerOpen).toBe(true);
    expect(fastMs).toBeLessThan(100);
    expect(fastMs).toBeLessThan(retryBudgetMs / 5);
  }, 30_000);

  it('/readyz payload reflects the open breaker', async () => {
    resetBreakers();
    const app = await buildServer({ seed: false });
    try {
      // Before: no breakers known → empty summary, ready.
      const before = await app.inject({ method: 'GET', url: '/readyz' });
      expect(before.statusCode).toBe(200);
      expect(before.json().breakers).toEqual({});

      // Trip the breaker (registry is process-global — the server reads it).
      const p = deadProvider();
      for (let i = 0; i < BREAKER.failureThreshold; i++) {
        await p.complete(REQ).catch(() => {});
      }
      expect(breakerStates()[KEY]).toBe('open');

      const after = await app.inject({ method: 'GET', url: '/readyz' });
      // db + memory queue are fine → still 200; the payload reports the open breaker.
      expect(after.statusCode).toBe(200);
      expect(after.json().breakers[KEY]).toBe('open');
    } finally {
      await app.close();
    }
  }, 90_000);
});
