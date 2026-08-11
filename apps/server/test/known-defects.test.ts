// KNOWN DEFECTS — filed, reproduced, not yet fixed. See the header of
// packages/db/src/known-defects.test.ts for why these are `it.fails` markers
// and why deleting one to make CI green is never the right move.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_LIMIT,
  InMemoryRateLimiterStore,
  type RateLimitConfig,
} from '../src/middleware/ratelimit.js';

describe('KNOWN DEFECT F18: the rate limiter is per-REPLICA in production', () => {
  // This is NOT a test-driver gap. There is exactly one RateLimiterStore
  // implementation and it is the one production runs (`opts.store ?? new
  // InMemoryRateLimiterStore()`). The seam exists; nothing fills it.
  //
  // docs/HA.md says: "the only cross-request in-memory state that matters for
  // correctness — the per-org providersForOrg BYOK cache — is kept coherent
  // across replicas by redis pub/sub invalidation". The token buckets and the
  // daily cap are also cross-request in-memory state that matters for
  // correctness, and they are coherent with nothing. That sentence is a
  // PHANTOM DECISION: a comment asserting a protection no code enforces.
  //
  // Consequences with N replicas behind the nginx round-robin HA.md draws:
  //   · effective rate and daily cap are N× the contracted number;
  //   · a rollout resets every bucket, so a client can lift its own limit by
  //     inducing one.
  const cfg: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, rps: 100, dailyCap: 10 };

  it.fails('one key\'s DAILY CAP holds across two replicas (today: 2× the cap)', () => {
    const replicaA = new InMemoryRateLimiterStore();
    const replicaB = new InMemoryRateLimiterStore();
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    let allowed = 0;
    // 20 requests round-robined across two replicas, cap is 10.
    for (let i = 0; i < 20; i++) {
      const store = i % 2 === 0 ? replicaA : replicaB;
      if (store.consume('key_f18', cfg, now).allowed) allowed += 1;
    }
    expect(allowed).toBe(10); // today: 20 — each replica counts to 10 alone
  });

  it.fails('a replica restart does not hand the key a fresh burst budget', () => {
    const cfgB: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, rps: 5, dailyCap: 1_000 };
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const before = new InMemoryRateLimiterStore();
    let allowed = 0;
    for (let i = 0; i < 5; i++) if (before.consume('key_f18', cfgB, now).allowed) allowed += 1;
    expect(allowed).toBe(5); // the full burst budget, then drained
    expect(before.consume('key_f18', cfgB, now).allowed).toBe(false);
    // Rollout: same instant, fresh process. State should survive it.
    const after = new InMemoryRateLimiterStore();
    expect(after.consume('key_f18', cfgB, now).allowed).toBe(false);
  });
});
