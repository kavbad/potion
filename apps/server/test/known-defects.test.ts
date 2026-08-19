// KNOWN DEFECTS — filed, reproduced, not yet fixed. See the header of
// packages/db/src/known-defects.test.ts for why these are `it.fails` markers
// and why deleting one to make CI green is never the right move.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_LIMIT,
  InMemoryRateLimiterStore,
  type RateLimitConfig,
} from '../src/middleware/ratelimit.js';

describe('F18 — CLOSED: the rate limiter is shared across replicas', () => {
  // WAS: InMemoryRateLimiterStore was the only implementation of the store
  // seam and it was what production ran, so with N replicas a key's rate AND
  // daily cap were both N×, and a rollout emptied every bucket — a client
  // could lift its own limit by inducing one. docs/HA.md called the BYOK
  // cache "the only cross-request in-memory state that matters for
  // correctness", which the token buckets falsified.
  //
  // NOW: RedisRateLimiterStore fills the seam (refill+check+consume in one
  // Lua script, so two replicas cannot both spend the same token), selected
  // automatically when REDIS_URL is set — which the production compose sets.
  //
  // The two failing expectations that used to live here are now PASSING
  // assertions in apps/server/test/f18-shared-rate-limit.test.ts, against the
  // shared store: one shared burst across replicas, one shared daily cap, and
  // a bucket that survives a rollout. This block keeps only what remains
  // true — that the in-memory store, used alone, still has the property that
  // made it wrong for multi-replica serving. That is not a defect now; it is
  // the reason the selection exists, and pinning it stops someone
  // "simplifying" resolveRateLimiterStore back to a hardcoded in-memory store.
  const cfg: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, rps: 100, dailyCap: 10 };

  it('in-memory buckets are STILL per-process — which is why REDIS_URL selects the shared store', () => {
    const replicaA = new InMemoryRateLimiterStore();
    const replicaB = new InMemoryRateLimiterStore();
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const store = i % 2 === 0 ? replicaA : replicaB;
      if ((store.consume('key_f18', cfg, now) as { allowed: boolean }).allowed) allowed += 1;
    }
    // Two independent processes, each counting to 10 alone. Correct for what
    // it is; wrong as a fleet-wide limit, hence the Redis store.
    expect(allowed).toBe(20);
  });
});
