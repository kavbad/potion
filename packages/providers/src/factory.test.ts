// ---------------------------------------------------------------------------
// The 60s clamp nobody declared (2026-08-20). resolveTimeoutMs threaded the
// declared timeout into the HTTP transport, but the `resilient` wrapper's
// per-attempt timeout never received it and clamped every attempt at its
// 60_000 default. A 1200ms probe "proved" the plumbing because the inner
// timeout fired first; anything needing 60–180s died at 60. These pin the
// policy actually handed to the wrapper.
//
// 2026-09-04 — THESE TESTS DID NOT TEST THAT. Both had pivoted to something
// weaker than their names claim, and the regression was unguarded:
//   · "a slow declared timeout is NOT clamped by the wrapper at 60s" built a
//     slow provider, threw it away with `void slow`, and asserted only
//     `resolveTimeoutMs(100) === 100` — a pure function returning its own
//     argument. It never touched the wrapper.
//   · "the wrapper timeout is declared + headroom" asserted only that
//     createProviders does not throw.
// Neither could fail if the clamp came back. The chain has two links, so it
// is pinned in two places: the factory must HAND the wrapper a timeout
// derived from the declared value, and that policy must GOVERN the abort.
import { describe, expect, it, vi } from 'vitest';
import type { PriceTable } from '@potion/core';
import type { CompleteRequest, CompleteResponse, Provider } from './types.js';
import type { ResiliencePolicy } from './resilience.js';

// Captures every policy the factory hands to `resilient`. Hoisted because
// vi.mock is hoisted above ordinary declarations.
const { policies } = vi.hoisted(() => ({ policies: [] as Array<Partial<ResiliencePolicy> | undefined> }));

vi.mock('./resilience.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resilience.js')>();
  return {
    ...actual,
    // Delegates to the real implementation — this records the argument, it
    // does not change behaviour, so the second describe below still
    // exercises the genuine wrapper.
    resilient: (p: Provider, policy?: Partial<ResiliencePolicy>) => {
      policies.push(policy);
      return actual.resilient(p, policy);
    },
  };
});

const { createProviders, resolveTimeoutMs } = await import('./factory.js');
const { resilient } = await import('./resilience.js');

const prices: PriceTable = { version: 'test', updatedAt: '2026-01-01T00:00:00Z', entries: [] };

/** The wrapper's timeout is the declared value plus this, so the transport's
 * own abort — the layer that accounts the attempt correctly — fires first. */
const HEADROOM_MS = 5_000;

describe('the factory hands the resilience wrapper a declared timeout', () => {
  it('a 180s declared timeout reaches the wrapper as 185s — not the 60s default', () => {
    policies.length = 0;
    createProviders({ prices, timeoutMs: 180_000, breaker: null });
    expect(policies.length).toBeGreaterThan(0);
    // EVERY provider, not just the first: the clamp bit whichever one served.
    for (const p of policies) {
      expect(p?.timeoutMs).toBe(180_000 + HEADROOM_MS);
      expect(p?.timeoutMs).not.toBe(60_000);
    }
  });

  it('carries no timeout when none is declared, so the wrapper keeps its own default', () => {
    policies.length = 0;
    createProviders({ prices, breaker: null });
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) expect(p?.timeoutMs).toBeUndefined();
  });

  it('resolveTimeoutMs passes an explicit declaration through untouched', () => {
    expect(resolveTimeoutMs(100)).toBe(100);
    expect(resolveTimeoutMs(180_000)).toBe(180_000);
  });
});

describe('that policy actually governs the abort', () => {
  /** A provider that never answers — the shape the clamp used to kill. */
  const hanging: Provider = {
    id: 'mock',
    complete: () => new Promise<CompleteResponse>(() => {}),
  };
  const req: CompleteRequest = { model: 'mock-cheap', messages: [{ role: 'user', content: 'hi' }] };

  it('a 185s attempt survives the old 60s clamp point and aborts at 185s', async () => {
    vi.useFakeTimers();
    try {
      // retries: 0 — one attempt, so the assertion is about the timeout and
      // not about the retry ladder's total elapsed time.
      const wrapped = resilient(hanging, { timeoutMs: 180_000 + HEADROOM_MS, retries: 0 });
      const settled = vi.fn();
      const call = wrapped.complete(req);
      // Attach now so the rejection is always handled, whenever it lands.
      void call.then(settled, settled);

      // THE REGRESSION: under the old clamp this had already rejected here.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(settled, 'aborted at the 60s default — the clamp is back').not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(130_000);
      await expect(call).rejects.toThrow(/timed out after 185000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a declared timeout the wrapper still backstops at its 60s default', async () => {
    vi.useFakeTimers();
    try {
      const wrapped = resilient(hanging, { retries: 0 });
      const call = wrapped.complete(req);
      const settled = vi.fn();
      void call.then(settled, settled);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(call).rejects.toThrow(/timed out after 60000ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});
