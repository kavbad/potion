// REDIS-BACKED RATE LIMITER STORE — closing F18.
//
// THE DEFECT. `InMemoryRateLimiterStore` holds its token buckets in a
// process-local Map, and it is the ONLY implementation, so it is what
// production runs. With N replicas a key's rate AND daily cap are both N×
// what the key was sold, and a rollout empties every bucket — a client can
// lift its own limit by inducing one. docs/HA.md carries a ⛔ "do not deploy
// multiple replicas" note because of exactly this.
//
// SCOPE, stated precisely because I previously overstated it. This is the
// per-replica defect; the BUDGET hard stop is NOT. `checkBudgetHardStop`
// reads MTD spend and platform day-spend from the SHARED database, so the
// cap threshold is global — only the 60s memo of the answer is per-process,
// which bounds overshoot by one staleness window of traffic rather than
// multiplying the cap. Different defect, different size, and conflating them
// would have sent this fix at the wrong target.
//
// THE ALGORITHM IS THE IN-MEMORY ONE, MOVED — not a reinterpretation. Same
// continuous refill capped at rps, same UTC-day counter, same precedence
// (daily cap beats the burst bucket), same retry-after arithmetic. It runs
// as a single Lua script so refill-check-consume is ATOMIC: two replicas
// hitting the same key in the same millisecond must not both read tokens=1
// and both decide they may spend it, which is precisely the race a
// GET-then-SET implementation would have.
//
// KEY EXPIRY: two days past last touch. Long enough that a bucket survives
// any realistic idle gap within a UTC day, short enough that Redis does not
// accumulate a key per api key ever seen.
import type { RateLimitConfig, RateLimitVerdict, RateLimiterStore } from './ratelimit.js';

/** Redis commands this store needs — the subset, so tests can supply a stub. */
export interface RateLimiterRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export const BUCKET_TTL_SEC = 2 * 24 * 60 * 60;

/**
 * Refill, check, consume — atomically.
 *
 * Returns a flat array rather than a table because ioredis decodes Lua
 * tables to arrays and drops nils, so a positional contract is the one that
 * survives the round trip unambiguously:
 *   {allowed, remaining, resetEpochSec, retryAfterSec, reason}
 */
export const CONSUME_LUA = `
local key      = KEYS[1]
local rps      = tonumber(ARGV[1])
local dailyCap = tonumber(ARGV[2])
local nowMs    = tonumber(ARGV[3])
local today    = ARGV[4]
local ttl      = tonumber(ARGV[5])

local b = redis.call('HMGET', key, 'tokens', 'lastRefillMs', 'day', 'dayUsed')
local tokens       = tonumber(b[1])
local lastRefillMs = tonumber(b[2])
local day          = b[3]
local dayUsed      = tonumber(b[4])

if tokens == nil then
  tokens = rps
  lastRefillMs = nowMs
  day = today
  dayUsed = 0
end

-- continuous refill, capped at capacity (= rps); a config change clamps into
-- the new [0, rps] range exactly as the in-memory store does
local elapsedSec = math.max(0, (nowMs - lastRefillMs) / 1000)
tokens = math.min(rps, tokens + elapsedSec * rps)
lastRefillMs = nowMs

if day ~= today then
  day = today
  dayUsed = 0
end

local secondsToMidnight = ARGV[6]

-- daily cap takes precedence over the burst bucket: a capped key stays
-- rejected until midnight even though tokens keep refilling
if dayUsed >= dailyCap then
  redis.call('HSET', key, 'tokens', tokens, 'lastRefillMs', lastRefillMs, 'day', day, 'dayUsed', dayUsed)
  redis.call('EXPIRE', key, ttl)
  local retry = tonumber(secondsToMidnight)
  return {0, 0, math.floor(nowMs / 1000) + retry, retry, 'daily_cap'}
end

if tokens < 1 then
  redis.call('HSET', key, 'tokens', tokens, 'lastRefillMs', lastRefillMs, 'day', day, 'dayUsed', dayUsed)
  redis.call('EXPIRE', key, ttl)
  local retry = math.max(1, math.ceil((1 - tokens) / rps))
  return {0, 0, math.floor(nowMs / 1000) + retry, retry, 'rate'}
end

tokens = tokens - 1
dayUsed = dayUsed + 1
redis.call('HSET', key, 'tokens', tokens, 'lastRefillMs', lastRefillMs, 'day', day, 'dayUsed', dayUsed)
redis.call('EXPIRE', key, ttl)
local refill = math.ceil((rps - tokens) / rps)
return {1, math.floor(tokens), math.floor(nowMs / 1000) + refill, 0, 'ok'}
`;

function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function secondsToUtcMidnight(ms: number): number {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - ms) / 1000));
}

export class RedisRateLimiterStore implements RateLimiterStore {
  constructor(
    private readonly redis: RateLimiterRedis,
    private readonly prefix = 'rl:',
  ) {}

  async consume(
    keyId: string,
    cfg: RateLimitConfig,
    nowMs: number = Date.now(),
  ): Promise<RateLimitVerdict> {
    const raw = (await this.redis.eval(
      CONSUME_LUA,
      1,
      `${this.prefix}${keyId}`,
      cfg.rps,
      cfg.dailyCap,
      nowMs,
      utcDayOf(nowMs),
      BUCKET_TTL_SEC,
      secondsToUtcMidnight(nowMs),
    )) as Array<string | number>;

    const allowed = Number(raw[0]) === 1;
    const remaining = Number(raw[1]);
    const resetEpochSec = Number(raw[2]);
    const retryAfterSec = Number(raw[3]);
    const reason = String(raw[4]);

    if (allowed) return { allowed: true, remaining, resetEpochSec };
    return {
      allowed: false,
      reason: reason === 'daily_cap' ? 'daily_cap' : 'rate',
      retryAfterSec,
      remaining: 0,
      resetEpochSec,
    };
  }
}
