// Rate limiting (M2 Wave 2, ROADMAP #17) — token-bucket per api key, in
// front of /v1/chat/completions.
//
// Limits (per key; columns added in migration 0006, NULL = platform default):
//   · rate_rps    requests/sec — bucket capacity AND refill rate (default 10)
//   · daily_cap   allowed requests per UTC day (default 10_000)
//   · max_body_kb request body ceiling in KiB (default 1024 = 1 MiB)
//
// Precedence + cost: the check runs in an onRequest hook — BEFORE body
// parsing and BEFORE strategy execution — so rejected traffic costs one
// sha256 + one indexed api_keys lookup + in-memory bucket math, and zero
// model calls. Rejections are logged to request_logs (status
// 'rate_limited' / 'payload_too_large') so throttled traffic stays
// auditable; the usage rollup counts only status='ok' rows, so rejections
// never become billable usage.
//
// Body limit: the GLOBAL 1 MiB ceiling is Fastify's built-in default
// bodyLimit (fastify rejects oversized bodies with 413 before the handler).
// max_body_kb overrides BELOW that ceiling are enforced here via the
// content-length header (the only pre-parse signal). Overrides ABOVE 1 MiB
// are documented as clamped — raising the global ceiling is an ops decision
// (Fastify serverOptions.bodyLimit), not a per-key one.
//
// Responses carry x-ratelimit-remaining-requests + x-ratelimit-reset (epoch
// seconds when the bucket is full again / the UTC day rolls over). 429s add
// Retry-After (seconds) and an OpenAI-style error body (code
// 'rate_limit_exceeded').
//
// HA note: InMemoryRateLimiterStore is process-local. For multi-replica
// serving, swap in a Redis-backed RateLimiterStore (the interface is the
// seam — see TODO in this file); the hook code does not change.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isServingRoute } from '../security/serving-routes.js';
import { sha256 } from '@potion/core';
import { getApiKeyByKeyHash, insertRequestLog, type ApiKeyRow } from '@potion/db';
import { bearerToken, openAiError } from '../auth.js';
import type { PotionContext } from '../context.js';

/** Per-key limit set (post-default-resolution). */
export interface RateLimitConfig {
  /** Bucket capacity AND refill rate (tokens = requests, per second). */
  rps: number;
  /** Max allowed requests per UTC day. */
  dailyCap: number;
  /** Per-key request body ceiling in KiB (enforced via content-length). */
  maxBodyKb: number;
}

/** Platform defaults — used when the api_keys columns are NULL. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  rps: 10,
  dailyCap: 10_000,
  maxBodyKb: 1024,
};

/**
 * ORG-LEVEL CEILING (SERVING-ROADMAP S4).
 *
 * The per-key bucket above is the only limit that existed, and an org may
 * mint as many keys as it likes — so N keys bought N × the limit, and the
 * "limit" was really a per-key formality. Harmless while the customer paid
 * for whatever got through; not harmless on our own key.
 *
 * The multiplier, and why it is not 1: a real org legitimately runs several
 * services on separate keys, and collapsing them all into one key's budget
 * would throttle honest use. 10× leaves any plausible key count unaffected
 * while capping the pathological case (mint 500 keys, get 500× the rate) at
 * a fixed, knowable blast radius.
 *
 * This bounds REQUEST RATE, not spend — the budget hard stop is what actually
 * protects the money, and this is the second wall behind it. Saying so
 * matters: a rate limit read as a spend control is how an org with a 10 rps
 * allowance quietly runs up a bill on expensive completions.
 */
export const ORG_LIMIT_MULTIPLIER = 10;

/** Prefix that keeps org buckets from ever colliding with key-id buckets. */
export const ORG_BUCKET_PREFIX = 'org:';

export function orgRateLimitConfig(cfg: RateLimitConfig): RateLimitConfig {
  return {
    rps: cfg.rps * ORG_LIMIT_MULTIPLIER,
    dailyCap: cfg.dailyCap * ORG_LIMIT_MULTIPLIER,
    // Body size is a per-request property; multiplying it would be meaningless.
    maxBodyKb: cfg.maxBodyKb,
  };
}

/** Resolve a key row's effective limits (NULL columns → defaults). */
export function rateLimitConfigForKey(key: ApiKeyRow): RateLimitConfig {
  return {
    rps: key.rateRps ?? DEFAULT_RATE_LIMIT.rps,
    dailyCap: key.dailyCap ?? DEFAULT_RATE_LIMIT.dailyCap,
    maxBodyKb: key.maxBodyKb ?? DEFAULT_RATE_LIMIT.maxBodyKb,
  };
}

export type RateLimitVerdict =
  | { allowed: true; remaining: number; resetEpochSec: number }
  | {
      allowed: false;
      reason: 'rate' | 'daily_cap';
      retryAfterSec: number;
      remaining: 0;
      resetEpochSec: number;
    };

/**
 * The store seam (HA swap point). Implementations must make consume() an
 * atomic check-and-increment for one request.
 *
 * TODO(HA): RedisRateLimiterStore — the bucket state maps 1:1 to a Redis
 * hash per key (`rl:{keyId}`: tokens, last_refill_ms, day, day_used) updated
 * by a Lua script (atomic refill+check+consume, EXPIRE ~2 days). Until
 * multi-replica serving is real, the in-memory store below is the default.
 */
export interface RateLimiterStore {
  consume(keyId: string, cfg: RateLimitConfig, nowMs?: number): RateLimitVerdict;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  /** UTC day 'YYYY-MM-DD' the dayUsed counter belongs to. */
  day: string;
  dayUsed: number;
}

function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Seconds from `ms` to the next UTC midnight (min 1). */
function secondsToUtcMidnight(ms: number): number {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - ms) / 1000));
}

/**
 * Process-local token buckets, one per api key id. Deterministic under an
 * injected clock (nowMs) for tests. Unbounded Map like the assignment cache
 * (process-lifetime; one entry per distinct key ever seen).
 */
export class InMemoryRateLimiterStore implements RateLimiterStore {
  private readonly buckets = new Map<string, BucketState>();

  consume(keyId: string, cfg: RateLimitConfig, nowMs: number = Date.now()): RateLimitVerdict {
    let b = this.buckets.get(keyId);
    if (!b) {
      b = { tokens: cfg.rps, lastRefillMs: nowMs, day: utcDayOf(nowMs), dayUsed: 0 };
      this.buckets.set(keyId, b);
    }

    // Refill: continuous, capped at capacity (= rps). A config change clamps
    // the stored token count into the new [0, rps] range.
    const elapsedSec = Math.max(0, (nowMs - b.lastRefillMs) / 1000);
    b.tokens = Math.min(cfg.rps, b.tokens + elapsedSec * cfg.rps);
    b.lastRefillMs = nowMs;

    // UTC-day rollover resets the daily counter.
    const today = utcDayOf(nowMs);
    if (b.day !== today) {
      b.day = today;
      b.dayUsed = 0;
    }

    // Daily cap takes precedence over the burst bucket: a capped key stays
    // rejected until midnight even though tokens keep refilling.
    if (b.dayUsed >= cfg.dailyCap) {
      const retryAfterSec = secondsToUtcMidnight(nowMs);
      return {
        allowed: false,
        reason: 'daily_cap',
        retryAfterSec,
        remaining: 0,
        resetEpochSec: Math.floor(nowMs / 1000) + retryAfterSec,
      };
    }

    if (b.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / cfg.rps));
      return {
        allowed: false,
        reason: 'rate',
        retryAfterSec,
        remaining: 0,
        resetEpochSec: Math.floor(nowMs / 1000) + retryAfterSec,
      };
    }

    b.tokens -= 1;
    b.dayUsed += 1;
    const refillSec = Math.ceil((cfg.rps - b.tokens) / cfg.rps);
    return {
      allowed: true,
      remaining: Math.floor(b.tokens),
      resetEpochSec: Math.floor(nowMs / 1000) + refillSec,
    };
  }
}

// F6: this was `const RATE_LIMITED_PATH = '/v1/chat/completions'` with a note
// that "usage/dashboard routes are local-tool read surfaces and stay
// unthrottled" — true of READ surfaces, but /v1/completions and
// /v1/embeddings did not exist when it was written (rate limiting is M2
// Wave 2; the parity routes are M3 #25). The single literal therefore left
// two SPEND routes unthrottled while two comments elsewhere asserted the
// opposite. Scope now comes from the serving-route inventory, so a new spend
// route is throttled the moment it is registered there.
// Read surfaces (usage/dashboard) remain deliberately unthrottled.

export interface RateLimitRegistrationOptions {
  /** Store override (tests); default: a fresh InMemoryRateLimiterStore. */
  store?: RateLimiterStore;
}

/**
 * Register the rate-limit hook. Append-only registration from server.ts —
 * the hook matches on routeOptions.url, so no changes to routes/chat.ts.
 */
export function registerRateLimiting(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: RateLimitRegistrationOptions = {},
): RateLimiterStore {
  const store = opts.store ?? new InMemoryRateLimiterStore();

  const logRejection = async (fields: {
    orgId: string;
    apiKeyId: string;
    status: string;
  }): Promise<void> => {
    try {
      await insertRequestLog(ctx.db.db, { ...fields, latencyMs: 0 });
    } catch (err) {
      app.log.warn(err, 'request_logs insert failed (rate-limit rejection)');
    }
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'POST' || !isServingRoute(req.routeOptions.url)) return;

    // Resolve the key directly (no policy read — the chat route does its own
    // full authenticate()). Unknown/missing tokens pass through: the route
    // answers 401 itself and there is no tenant to meter against.
    const token = bearerToken(req.headers.authorization);
    if (!token) return;
    const key = await getApiKeyByKeyHash(ctx.db.db, sha256(token));
    if (!key) return;

    const cfg = rateLimitConfigForKey(key);

    // Per-key body ceiling via content-length (pre-parse signal). The global
    // 1 MiB ceiling is Fastify's built-in bodyLimit — see file header.
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > cfg.maxBodyKb * 1024) {
      await logRejection({ orgId: key.orgId, apiKeyId: key.id, status: 'payload_too_large' });
      return reply
        .code(413)
        .send(
          openAiError(
            `request body exceeds this key's limit of ${cfg.maxBodyKb} KiB`,
            'invalid_request_error',
            'request_too_large',
          ),
        );
    }

    const verdict = store.consume(key.id, cfg);
    void reply.header('x-ratelimit-remaining-requests', String(verdict.remaining));
    void reply.header('x-ratelimit-reset', String(verdict.resetEpochSec));

    if (!verdict.allowed) {
      await logRejection({ orgId: key.orgId, apiKeyId: key.id, status: 'rate_limited' });
      const message =
        verdict.reason === 'daily_cap'
          ? `daily request cap of ${cfg.dailyCap} reached for this api key — retry after UTC midnight`
          : `rate limit of ${cfg.rps} requests/sec reached for this api key`;
      return reply
        .code(429)
        .header('retry-after', String(verdict.retryAfterSec))
        .send(openAiError(message, 'rate_limit_exceeded', 'rate_limit_exceeded'));
    }

    // S4: the ORG ceiling, consumed only after the key bucket allowed the
    // request, so a key already over its own limit does not also burn org
    // budget. Same store, same math — the bucket key is the org, prefixed so
    // it can never collide with an api-key id.
    const orgCfg = orgRateLimitConfig(cfg);
    const orgVerdict = store.consume(`${ORG_BUCKET_PREFIX}${key.orgId}`, orgCfg);
    if (!orgVerdict.allowed) {
      await logRejection({ orgId: key.orgId, apiKeyId: key.id, status: 'rate_limited' });
      const message =
        orgVerdict.reason === 'daily_cap'
          ? `daily request cap of ${orgCfg.dailyCap} reached for this ORGANIZATION (across all ` +
            `of its api keys) — retry after UTC midnight`
          : `rate limit of ${orgCfg.rps} requests/sec reached for this ORGANIZATION (across all ` +
            `of its api keys)`;
      return reply
        .code(429)
        .header('retry-after', String(orgVerdict.retryAfterSec))
        .send(openAiError(message, 'rate_limit_exceeded', 'rate_limit_exceeded'));
    }
  });

  return store;
}
