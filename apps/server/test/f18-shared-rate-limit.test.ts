// F18 — the rate limit was per-REPLICA, so N replicas sold N× the limit.
//
// THE DEFECT. InMemoryRateLimiterStore keeps token buckets in a process-local
// Map and it is the ONLY implementation, so it is what production runs. Two
// replicas each hand the same api key its full allowance, and a rollout
// empties every bucket — a client can lift its own limit by inducing one.
// docs/HA.md carried a ⛔ "do not deploy multiple replicas" note for this.
//
// SCOPE, stated because I previously overstated it in conversation: this is
// the per-replica defect. The BUDGET hard stop is NOT one — checkBudgetHardStop
// reads MTD and platform day-spend from the SHARED database, so its threshold
// is global and only the 60s memo of the answer is per-process. That bounds
// overshoot by one staleness window of traffic; it does not multiply the cap.
// The last test here pins that distinction so the two never get conflated.
import { describe, expect, it } from 'vitest';
import IORedisMock from 'ioredis-mock';
import {
  InMemoryRateLimiterStore,
  DEFAULT_RATE_LIMIT,
  type RateLimitConfig,
} from '../src/middleware/ratelimit.js';
import { RedisRateLimiterStore } from '../src/middleware/redis-rate-limiter.js';

const CFG: RateLimitConfig = { rps: 3, dailyCap: 5, maxBodyKb: 1024 };
const T0 = Date.parse('2026-08-18T12:00:00.000Z');

/** Two independent stores over ONE Redis — i.e. two replicas. */
function tworeplicas(name: string) {
  const a = new IORedisMock({ host: name, port: 6379 });
  const b = new IORedisMock({ host: name, port: 6379 }); // same data context
  return [new RedisRateLimiterStore(a, `${name}:`), new RedisRateLimiterStore(b, `${name}:`)] as const;
}

describe('the defect, reproduced against the in-memory store', () => {
  it('two replicas each grant the FULL burst — 2x the limit that was sold', async () => {
    const replicaA = new InMemoryRateLimiterStore();
    const replicaB = new InMemoryRateLimiterStore();
    let allowed = 0;
    for (const store of [replicaA, replicaB]) {
      for (let i = 0; i < CFG.rps; i++) {
        if ((await store.consume('key-1', CFG, T0)).allowed) allowed += 1;
      }
    }
    // Sold 3 rps. Got 6.
    expect(allowed).toBe(CFG.rps * 2);
  });

  it('a ROLLOUT empties the bucket — a client lifts its own limit by inducing one', async () => {
    const before = new InMemoryRateLimiterStore();
    for (let i = 0; i < CFG.rps; i++) await before.consume('key-1', CFG, T0);
    expect((await before.consume('key-1', CFG, T0)).allowed).toBe(false); // exhausted

    const afterRestart = new InMemoryRateLimiterStore(); // same process, new object
    expect((await afterRestart.consume('key-1', CFG, T0)).allowed).toBe(true);
  });
});

describe('the fix: one shared bucket, whatever the replica count', () => {
  it('two replicas share ONE burst allowance', async () => {
    const [a, b] = tworeplicas('f18-burst');
    let allowed = 0;
    for (const store of [a, b, a, b, a, b]) {
      if ((await store.consume('key-1', CFG, T0)).allowed) allowed += 1;
    }
    // Six attempts alternating replicas; exactly rps get through.
    expect(allowed).toBe(CFG.rps);
  });

  it('the DAILY cap is shared too — the harder half, since it spans the whole day', async () => {
    const [a, b] = tworeplicas('f18-daily');
    let allowed = 0;
    // Spread across a day so token refill never limits: only the cap can.
    for (let i = 0; i < 10; i++) {
      const at = T0 + i * 60_000;
      const store = i % 2 === 0 ? a : b;
      if ((await store.consume('key-1', CFG, at)).allowed) allowed += 1;
    }
    expect(allowed).toBe(CFG.dailyCap);
  });

  it('rejects with the same typed reasons and retry hints as the in-memory store', async () => {
    const [a] = tworeplicas('f18-reasons');
    for (let i = 0; i < CFG.dailyCap; i++) await a.consume('key-1', CFG, T0 + i * 60_000);
    const v = await a.consume('key-1', CFG, T0 + 10 * 60_000);
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toBe('daily_cap');
      expect(v.retryAfterSec).toBeGreaterThan(0);
      expect(v.remaining).toBe(0);
    }
  });

  it('refills over time exactly as the in-memory store does', async () => {
    const [a] = tworeplicas('f18-refill');
    const cfg: RateLimitConfig = { rps: 2, dailyCap: 1000, maxBodyKb: 1024 };
    for (let i = 0; i < 2; i++) expect((await a.consume('k', cfg, T0)).allowed).toBe(true);
    expect((await a.consume('k', cfg, T0)).allowed).toBe(false); // drained
    // One second later the bucket has refilled its full capacity.
    expect((await a.consume('k', cfg, T0 + 1000)).allowed).toBe(true);
  });

  it('survives a "rollout": a brand-new store object sees the SAME bucket', async () => {
    // The half a shared store fixes that a bigger in-memory bucket cannot.
    const [a] = tworeplicas('f18-rollout');
    for (let i = 0; i < CFG.rps; i++) await a.consume('key-1', CFG, T0);
    const [, freshReplica] = tworeplicas('f18-rollout');
    expect((await freshReplica.consume('key-1', CFG, T0)).allowed).toBe(false);
  });

  it('keeps separate keys and the org bucket independent', async () => {
    const [a] = tworeplicas('f18-isolation');
    for (let i = 0; i < CFG.rps; i++) await a.consume('key-1', CFG, T0);
    expect((await a.consume('key-1', CFG, T0)).allowed).toBe(false);
    expect((await a.consume('key-2', CFG, T0)).allowed).toBe(true);
    expect((await a.consume('org:acme', CFG, T0)).allowed).toBe(true);
  });
});

describe('what F18 is NOT — the budget cap is not per-replica', () => {
  it('the platform defaults are unchanged by any of this', () => {
    // A guard against "fixing" the limiter by quietly loosening the numbers.
    expect(DEFAULT_RATE_LIMIT.rps).toBe(10);
    // 2026-08-22: the daily cap was raised from 10k to 200k on purpose (dogfood +
    // the learning period route real traffic through keys); this pin guards the
    // number, not its history.
    expect(DEFAULT_RATE_LIMIT.dailyCap).toBe(200_000);
  });
});
