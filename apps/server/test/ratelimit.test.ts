// Rate limiting tests (M2 Wave 2, ROADMAP #17).
//   · bucket math: burst / reject / recovery / daily cap / day rollover —
//     deterministic via the store's injected clock
//   · end-to-end via app.inject: 429 + Retry-After + OpenAI-style body +
//     x-ratelimit-* headers, per-key overrides (rps, daily cap, body limit),
//     non-chat routes unthrottled
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, type Policy } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { buildServer } from '../src/server.js';
import {
  DEFAULT_RATE_LIMIT,
  InMemoryRateLimiterStore,
  rateLimitConfigForKey,
} from '../src/middleware/ratelimit.js';

// ---------------------------------------------------------------------------
// Bucket math (unit, injected clock)
// ---------------------------------------------------------------------------

describe('InMemoryRateLimiterStore bucket math', () => {
  const CFG = { rps: 2, dailyCap: 100, maxBodyKb: 1024 };
  const T0 = Date.UTC(2026, 7, 4, 12, 0, 0); // 2026-08-04T12:00:00Z

  it('burst up to capacity, then reject with retry-after, then recover', () => {
    const s = new InMemoryRateLimiterStore();
    // capacity == rps == 2
    expect(s.consume('k', CFG, T0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(s.consume('k', CFG, T0)).toMatchObject({ allowed: true, remaining: 0 });
    const rej = s.consume('k', CFG, T0);
    expect(rej).toMatchObject({ allowed: false, reason: 'rate', retryAfterSec: 1, remaining: 0 });
    // half a second later: exactly one token refilled (2 rps)
    expect(s.consume('k', CFG, T0 + 500)).toMatchObject({ allowed: true, remaining: 0 });
    expect(s.consume('k', CFG, T0 + 500).allowed).toBe(false);
    // full second later: one more token
    expect(s.consume('k', CFG, T0 + 1500)).toMatchObject({ allowed: true });
  });

  it('refill is capped at capacity (no accumulating huge bursts)', () => {
    const s = new InMemoryRateLimiterStore();
    expect(s.consume('k', CFG, T0).allowed).toBe(true);
    // 60 idle seconds → tokens clamp at capacity 2, not 122
    expect(s.consume('k', CFG, T0 + 60_000)).toMatchObject({ allowed: true, remaining: 1 });
    expect(s.consume('k', CFG, T0 + 60_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(s.consume('k', CFG, T0 + 60_000).allowed).toBe(false);
  });

  it('daily cap rejects until UTC midnight, then the day rolls over', () => {
    const s = new InMemoryRateLimiterStore();
    const cfg = { ...CFG, rps: 1000, dailyCap: 2 };
    expect(s.consume('k', cfg, T0).allowed).toBe(true);
    expect(s.consume('k', cfg, T0).allowed).toBe(true);
    const rej = s.consume('k', cfg, T0);
    // 12:00 UTC → 12h = 43200s to midnight
    expect(rej).toMatchObject({
      allowed: false,
      reason: 'daily_cap',
      retryAfterSec: 43_200,
      remaining: 0,
    });
    if (!rej.allowed) {
      expect(rej.resetEpochSec).toBe(Math.floor(T0 / 1000) + 43_200);
    }
    // next UTC day: counter reset → allowed again
    expect(s.consume('k', cfg, T0 + 43_200_000).allowed).toBe(true);
  });

  it('buckets are independent per key and per config', () => {
    const s = new InMemoryRateLimiterStore();
    expect(s.consume('a', CFG, T0).allowed).toBe(true);
    expect(s.consume('a', CFG, T0).allowed).toBe(true);
    expect(s.consume('a', CFG, T0).allowed).toBe(false);
    // key b untouched; a tighter config for a fresh key applies independently
    expect(s.consume('b', CFG, T0).allowed).toBe(true);
    expect(s.consume('c', { ...CFG, rps: 1 }, T0).allowed).toBe(true);
    expect(s.consume('c', { ...CFG, rps: 1 }, T0).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end via inject
// ---------------------------------------------------------------------------

const RAW_A = 'pk_rl_org_a';
const RAW_LIMITED = 'pk_rl_limited';
const RAW_CAPPED = 'pk_rl_capped';
const RAW_SMALLBODY = 'pk_rl_smallbody';
const RAW_BURST = 'pk_rl_burst';

const POLICY: Policy = { type: 'max_quality', costCeilingPer1K: 100 };
const PROMPT = { model: 'potion', messages: [{ role: 'user', content: 'reverse a string in python' }] };

let app: FastifyInstance;
const db = () => app.potion.db.db;

function chat(rawKey: string, payload: unknown = PROMPT) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown>,
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: 'org_rl', name: 'Rate Org' });
  await insertPolicy(db(), { id: 'pol-rl', orgId: 'org_rl', name: 'rl', config: POLICY });
  // default limits (all override columns NULL)
  await insertApiKey(db(), {
    id: 'key-rl-a',
    keyHash: sha256(RAW_A),
    name: 'a',
    orgId: 'org_rl',
    policyId: 'pol-rl',
  });
  // rps override: 1 req/s
  await insertApiKey(db(), {
    id: 'key-rl-limited',
    keyHash: sha256(RAW_LIMITED),
    name: 'limited',
    orgId: 'org_rl',
    policyId: 'pol-rl',
    rateRps: 1,
  });
  // daily cap override: 2 req/day
  await insertApiKey(db(), {
    id: 'key-rl-capped',
    keyHash: sha256(RAW_CAPPED),
    name: 'capped',
    orgId: 'org_rl',
    policyId: 'pol-rl',
    rateRps: 1000,
    dailyCap: 2,
  });
  // body limit override: 1 KiB
  await insertApiKey(db(), {
    id: 'key-rl-smallbody',
    keyHash: sha256(RAW_SMALLBODY),
    name: 'smallbody',
    orgId: 'org_rl',
    policyId: 'pol-rl',
    maxBodyKb: 1,
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('rate limiting via inject', () => {
  it('default key: first request gets the full-capacity headers (remaining = rps − 1)', async () => {
    const res = await chat(RAW_A);
    expect(res.statusCode).toBe(200);
    // bucket initialized at capacity == default rps; one token consumed
    expect(res.headers['x-ratelimit-remaining-requests']).toBe(String(DEFAULT_RATE_LIMIT.rps - 1));
    const reset = Number(res.headers['x-ratelimit-reset']);
    expect(Number.isFinite(reset)).toBe(true);
    expect(reset).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
  });

  it('burst/reject/recovery: 3-rps key — 4 concurrent requests → 3 ok + 1×429, then refill recovers', async () => {
    // fresh key with rps 3 (capacity 3): the concurrent burst drains the
    // bucket faster than the refill (consumes are milliseconds apart).
    await insertApiKey(db(), {
      id: 'key-rl-burst',
      keyHash: sha256(RAW_BURST),
      name: 'burst',
      orgId: 'org_rl',
      policyId: 'pol-rl',
      rateRps: 3,
    });
    const results = await Promise.all([chat(RAW_BURST), chat(RAW_BURST), chat(RAW_BURST), chat(RAW_BURST)]);
    const ok = results.filter((r) => r.statusCode === 200);
    const blocked = results.filter((r) => r.statusCode === 429);
    expect(ok).toHaveLength(3);
    expect(blocked).toHaveLength(1);
    const b = blocked[0]!;
    expect(Number(b.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(b.headers['x-ratelimit-remaining-requests']).toBe('0');
    // M3 #25: 429 type renamed rate_limit_error → rate_limit_exceeded (OpenAI parity).
    expect(b.json().error).toMatchObject({ type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' });
    expect(b.json().error.message).toContain('3 requests/sec');
    // recovery: 400ms at 3 rps refills ≥ 1 token
    await new Promise((r) => setTimeout(r, 400));
    expect((await chat(RAW_BURST)).statusCode).toBe(200);
  }, 15_000);

  it('per-key rps override (1 rps): second back-to-back request is 429, then recovers', async () => {
    expect((await chat(RAW_LIMITED)).statusCode).toBe(200);
    const blocked = await chat(RAW_LIMITED);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.message).toContain('1 requests/sec');
    // recovery after the 1s refill
    await new Promise((r) => setTimeout(r, 1100));
    expect((await chat(RAW_LIMITED)).statusCode).toBe(200);
  }, 15_000);

  it('per-key daily cap override (2/day): third request is a daily-cap 429', async () => {
    expect((await chat(RAW_CAPPED)).statusCode).toBe(200);
    expect((await chat(RAW_CAPPED)).statusCode).toBe(200);
    const blocked = await chat(RAW_CAPPED);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.message).toContain('daily request cap of 2');
    const retryAfter = Number(blocked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
  });

  it('per-key body limit override (1 KiB): oversized body is 413 pre-parse', async () => {
    const big = {
      model: 'potion',
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    };
    const res = await chat(RAW_SMALLBODY, big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'request_too_large' });
    // not bucket-consuming: a small request right after still succeeds
    expect((await chat(RAW_SMALLBODY)).statusCode).toBe(200);
  });

  it('non-chat routes are not throttled and carry no rate headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage',
      headers: { authorization: `Bearer ${RAW_A}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-remaining-requests']).toBeUndefined();
  });

  it('rateLimitConfigForKey: NULL columns resolve to the platform defaults', () => {
    const dflt = rateLimitConfigForKey({
      rateRps: null,
      dailyCap: null,
      maxBodyKb: null,
    } as Parameters<typeof rateLimitConfigForKey>[0]);
    expect(dflt).toEqual(DEFAULT_RATE_LIMIT);
  });
});
