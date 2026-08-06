// Cross-instance providersForOrg cache invalidation (SPEC §12.8, M3 #27 HA):
// redis pub/sub on channel `potion:invalidate:keys`. When a provider key is
// created/rotated/revoked, the local 60s providersForOrg cache entry is
// busted AND an invalidation is published so every OTHER replica drops the
// same org's entry immediately (sub-second) instead of waiting out the TTL.
//
// OPTIONAL-DEPENDENCY CONTRACT (mirrors observability's otel pattern):
// `ioredis` is NOT a dependency of this package — it is lazy-dynamic-imported
// only when REDIS_URL is set. When REDIS_URL is unset, the import fails, or
// the client cannot be built, we warn ONCE and fall back to memory-only mode
// (the pre-M3 behavior: local bust + 60s TTL). Publishing NEVER throws —
// key-lifecycle routes must not fail because a cache fan-out failed.

export const KEYS_INVALIDATION_CHANNEL = 'potion:invalidate:keys';

export type CacheInvalidationMode = 'redis' | 'memory';

export interface CacheInvalidationHandle {
  readonly mode: CacheInvalidationMode;
  readonly channel: string;
  /** Fan out an invalidation for orgId. No-op in memory mode. NEVER throws. */
  publish(orgId: string): Promise<void>;
  /** Tear down pub/sub connections (graceful shutdown). No-op in memory mode. */
  close(): Promise<void>;
}

/** Minimal slice of the ioredis client we use — structurally satisfiable by
 * test stubs (no ioredis types needed at compile time). */
export interface RedisPubSubLike {
  subscribe(channel: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export interface CacheInvalidationOptions {
  /** REDIS_URL; unset → memory-only mode (no import attempted). */
  redisUrl?: string | undefined;
  /** Pub/sub channel (default `potion:invalidate:keys`, SPEC §12.8). */
  channel?: string;
  /** Local cache bust — invoked for EVERY message on the channel, including
   * this instance's own publishes (a repeat local delete is harmless). */
  onInvalidate: (orgId: string) => void;
  log?: (msg: string) => void;
  /** Test hook: build the two redis clients (pub + sub) without ioredis. */
  redisFactory?: (url: string) => RedisPubSubLike;
  /** Test hook: simulate ioredis being absent/misbuilt (importer throws). */
  importer?: (name: string) => Promise<Record<string, unknown>>;
}

const MEMORY_HANDLE = (channel: string): CacheInvalidationHandle => ({
  mode: 'memory',
  channel,
  publish: async () => {},
  close: async () => {},
});

/** Dynamic import with an unanalyzable specifier so tsc never tries to
 * resolve the optional ioredis package at compile time (otel pattern). */
async function importOptional(name: string): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
}

let warnedRedisMissing = false;

/** Reset the warn-once latch (tests only). */
export function resetRedisWarningForTests(): void {
  warnedRedisMissing = false;
}

/**
 * createCacheInvalidator(opts) — redis pub/sub fan-out when REDIS_URL is set
 * AND ioredis is importable; memory-only otherwise. Two connections are used
 * (redis subscribers cannot publish on the same connection).
 */
export async function createCacheInvalidator(
  opts: CacheInvalidationOptions,
): Promise<CacheInvalidationHandle> {
  const channel = opts.channel ?? KEYS_INVALIDATION_CHANNEL;
  const log = opts.log ?? (() => {});
  if (!opts.redisUrl) return MEMORY_HANDLE(channel);

  const warnOnce = (msg: string): void => {
    if (warnedRedisMissing) return;
    warnedRedisMissing = true;
    log(msg);
  };

  let factory = opts.redisFactory;
  if (!factory) {
    try {
      const mod = await (opts.importer ?? importOptional)('ioredis');
      const Redis = (mod as { default?: unknown }).default ?? (mod as { Redis?: unknown }).Redis;
      if (typeof Redis !== 'function') throw new Error('ioredis loaded but its client export is missing');
      const Ctor = Redis as new (url: string) => RedisPubSubLike;
      factory = (url) => new Ctor(url);
    } catch (err) {
      warnOnce(
        `cache-invalidation: REDIS_URL set but ioredis is unavailable ` +
          `(${(err as Error).message}) — memory-only mode (60s TTL fallback)`,
      );
      return MEMORY_HANDLE(channel);
    }
  }

  try {
    const sub = factory(opts.redisUrl);
    const pub = factory(opts.redisUrl);
    sub.on('message', (msgChannel, message) => {
      if (msgChannel === channel && message) opts.onInvalidate(message);
    });
    await sub.subscribe(channel);
    log(`cache-invalidation: redis pub/sub on '${channel}' (cross-instance)`);
    return {
      mode: 'redis',
      channel,
      publish: async (orgId: string) => {
        try {
          await pub.publish(channel, orgId);
        } catch (err) {
          // Fan-out failure must NEVER fail a key-lifecycle request — the
          // local bust already happened and peers self-heal at the 60s TTL.
          log(`cache-invalidation: publish failed (${(err as Error).message}) — peers rely on TTL`);
        }
      },
      close: async () => {
        await Promise.allSettled([sub.quit(), pub.quit()]);
      },
    };
  } catch (err) {
    warnOnce(
      `cache-invalidation: redis unavailable (${(err as Error).message}) — ` +
        `memory-only mode (60s TTL fallback)`,
    );
    return MEMORY_HANDLE(channel);
  }
}
