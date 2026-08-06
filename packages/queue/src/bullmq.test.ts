// BullMQ driver tests (SPEC §12.2) — hermetic: backed by ioredis-mock via the
// src/testing shims (no container, no network). ioredis-mock shares one data
// context per host:port process-wide, so every test uses a UNIQUE queue name.
import { describe, expect, it } from 'vitest';
import { createBullMQQueue, createQueue, QueueUnavailableError } from './index.js';
import { createBullMqMockConnection } from './testing/mock-redis.js';

let counter = 0;
function testQueue(extra: Parameters<typeof createBullMQQueue>[0] = {}) {
  counter += 1;
  return createBullMQQueue({
    connection: createBullMqMockConnection(),
    queueName: `test-${process.pid}-${counter}`,
    // Small backoff so retry tests stay fast (default is 250ms ×2ⁿ).
    backoffMs: 30,
    ...extra,
  });
}

describe('bullmq driver (ioredis-mock, hermetic)', () => {
  it('enqueue → process round-trip with result via getJob', async () => {
    const q = testQueue();
    const seen: unknown[] = [];
    q.registerHandler('eval:run', async (payload) => {
      seen.push(payload);
      return { runId: 'run-1', ok: true };
    });
    const jobId = await q.enqueue('eval:run', { suiteIds: ['s1'] });

    // Wait for completion (poll getJob — the mock worker is async).
    let status = await q.getJob(jobId);
    for (let i = 0; i < 200 && status?.state !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await q.getJob(jobId);
    }
    expect(seen).toEqual([{ suiteIds: ['s1'] }]);
    expect(status?.state).toBe('completed');
    expect(status?.result).toEqual({ runId: 'run-1', ok: true });
    expect(status?.progress).toBe(100);
    await q.close();
  });

  it('retries a throwing handler 3 times, then marks the job failed', async () => {
    const q = testQueue();
    let attempts = 0;
    q.registerHandler('flaky', async () => {
      attempts += 1;
      throw new Error(`boom ${attempts}`);
    });
    const jobId = await q.enqueue('flaky', {});

    let status = await q.getJob(jobId);
    for (let i = 0; i < 400 && status?.state !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await q.getJob(jobId);
    }
    expect(attempts).toBe(3); // DEFAULT_ATTEMPTS
    expect(status?.state).toBe('failed');
    expect(status?.error).toContain('boom 3');
    await q.close();
  });

  it('jobs survive a driver restart (new driver, same data context)', async () => {
    const queueName = `test-${process.pid}-restart`;
    // "Boot 1": producer enqueues a job, no worker ever registered.
    const producer = testQueue({ queueName });
    const jobId = await producer.enqueue('eval:run', { suiteIds: ['after-restart'] });
    await producer.close(); // caller-provided connection is NOT closed

    // "Boot 2": a fresh driver over a fresh connection picks the job up.
    const consumer = testQueue({ queueName });
    const seen: unknown[] = [];
    consumer.registerHandler('eval:run', async (payload) => {
      seen.push(payload);
    });
    for (let i = 0; i < 200 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen).toEqual([{ suiteIds: ['after-restart'] }]);
    const status = await consumer.getJob(jobId);
    expect(status?.state).toBe('completed');
    await consumer.close();
  });

  it('throws QueueUnavailableError when Redis is unreachable', async () => {
    // No mock here: a real ioredis to a dead port, configured to fail fast.
    const q = createQueue('bullmq', {
      redisUrl: 'redis://127.0.0.1:1',
      queueName: `test-${process.pid}-dead`,
      connectionOptions: {
        retryStrategy: () => null, // no reconnect — commands flush with an error
        connectTimeout: 300,
        showFriendlyErrorStack: false,
      },
    });
    await expect(q.enqueue('eval:run', {})).rejects.toBeInstanceOf(QueueUnavailableError);
    await q.close();
  });
});
