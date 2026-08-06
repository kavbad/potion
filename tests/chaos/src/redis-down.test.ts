// Chaos: Redis down (ROADMAP #29, SPEC §12.9).
//
// TRUE BEHAVIOR (documented, tested here):
//   · createQueue('bullmq', { redisUrl: <dead> }) — enqueue/getJob reject with
//     the TYPED QueueUnavailableError; the message carries the redis URL with
//     credentials REDACTED (//user:***@ never leaks the password).
//   · The memory driver is UNAFFECTED: QUEUE_DRIVER=memory wins over a set
//     (dead) REDIS_URL — documented precedence in packages/queue/src/index.ts
//     (explicit kind > QUEUE_DRIVER > REDIS_URL set > memory). The server
//     boots and serves with QUEUE_DRIVER=memory while REDIS_URL points at a
//     dead host; /readyz reports the memory driver as ready (SPEC §12.8).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createQueue, QueueUnavailableError } from '@potion/queue';
import { buildServer } from '@potion/server/server';

const DEAD_REDIS = 'redis://localhost:1';

/** Fail-fast connection options (no ioredis reconnect loops in tests). */
const FAIL_FAST = { retryStrategy: () => null, connectTimeout: 500, lazyConnect: false };

describe('chaos: redis down — bullmq driver', () => {
  it('enqueue surfaces a typed QueueUnavailableError with a redacted URL', async () => {
    const q = createQueue('bullmq', { redisUrl: DEAD_REDIS, connectionOptions: FAIL_FAST });
    const err = await q.enqueue('eval:run', { suiteIds: ['s1'] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(QueueUnavailableError);
    expect((err as QueueUnavailableError).message).toContain('redis://localhost:1');
    await q.close().catch(() => {});
  }, 20_000);

  it('credentials in the redis URL never leak into the error message', async () => {
    const secret = 'chaos-redis-password-123';
    const q = createQueue('bullmq', {
      redisUrl: `redis://default:${secret}@localhost:1`,
      connectionOptions: FAIL_FAST,
    });
    const err = await q.enqueue('eval:run', {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(QueueUnavailableError);
    expect((err as QueueUnavailableError).message).not.toContain(secret);
    expect((err as QueueUnavailableError).message).toContain('//***@');
    await q.close().catch(() => {});
  }, 20_000);

  it('getJob surfaces the same typed error when redis is dead', async () => {
    const q = createQueue('bullmq', { redisUrl: DEAD_REDIS, connectionOptions: FAIL_FAST });
    const err = await q.getJob('some-job-id').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(QueueUnavailableError);
    await q.close().catch(() => {});
  }, 20_000);
});

describe('chaos: redis down — memory driver unaffected (env precedence)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['QUEUE_DRIVER', 'REDIS_URL']) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('QUEUE_DRIVER=memory wins over a dead REDIS_URL in createQueue()', () => {
    process.env.QUEUE_DRIVER = 'memory';
    process.env.REDIS_URL = DEAD_REDIS;
    const q = createQueue();
    expect(q.constructor.name).toBe('MemoryQueue');
  });

  it('server boots and serves with QUEUE_DRIVER=memory while REDIS_URL is dead', async () => {
    process.env.QUEUE_DRIVER = 'memory';
    process.env.REDIS_URL = DEAD_REDIS;
    const app = await buildServer({ seed: false });
    try {
      const health = await app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
      expect(health.json().ok).toBe(true);

      // /readyz: the memory queue driver has nothing external to ping → ok.
      const ready = await app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.queue).toMatchObject({ ok: true, driver: 'memory' });

      // …and the jobs surface still works end-to-end through the dead-REDIS_URL env.
      const evalRes = await app.inject({
        method: 'POST',
        url: '/api/evals',
        headers: { 'content-type': 'application/json' },
        payload: { suiteIds: ['extraction'], strategyHashes: [] },
      });
      // 202 (enqueued in memory) or 4xx for the unknown suite — but NEVER a
      // 5xx QueueUnavailableError from the dead redis.
      expect(evalRes.statusCode).toBeLessThan(500);
    } finally {
      await app.close();
    }
  }, 90_000);

  it(
    'without QUEUE_DRIVER, a set REDIS_URL still selects bullmq (documented precedence)',
    { timeout: 20_000 },
    async () => {
      delete process.env.QUEUE_DRIVER;
      process.env.REDIS_URL = DEAD_REDIS;
      const q = createQueue();
      expect(q.constructor.name).toBe('BullMQPotionQueue');
      await q.close().catch(() => {});
    },
  );
});
