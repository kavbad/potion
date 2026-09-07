// P1-3's open gap, closed (2026-09-06).
//
// The split shipped with a hole I named at the time: POTION_WORKER=off with
// Redis present and the standalone worker NOT started is undetected. Jobs are
// accepted into Redis and nothing runs them — every research cycle, guarantee
// sweep and alert dispatch swallowed, with nothing anywhere erroring.
//
// The boot gate could not catch it. At boot, "no worker attached yet" and "no
// worker will ever attach" are the same observation. It is a runtime
// condition, so it is answered at runtime.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMemoryQueue } from '@potion/queue';
import { assessConsumers, checkReadiness } from '../src/readiness.js';

const SAVED = process.env.POTION_WORKER;
afterEach(() => {
  if (SAVED === undefined) delete process.env.POTION_WORKER;
  else process.env.POTION_WORKER = SAVED;
});

describe('P1-3: is anything draining the queue', () => {
  it('work waiting with nothing attached is a STALL, and says what to do', () => {
    const r = assessConsumers({ waiting: 7, consumers: 0 });
    expect(r.stalled).toBe(true);
    expect(r.detail).toContain('NO consumer attached');
    expect(r.detail).toContain('POTION_WORKER=off');
    // Jobs are not lost — the operator needs to know that too, or the fix
    // looks like it needs a replay.
    expect(r.detail).toContain('accumulating');
  });

  it('waiting alone is NOT a stall — a busy worker leaves a queue', () => {
    // One consumer inside a 24-minute research cycle legitimately leaves the
    // next jobs waiting. A check that fired on depth would be muted in a week.
    expect(assessConsumers({ waiting: 12, consumers: 1 }).stalled).toBe(false);
  });

  it('zero consumers alone is NOT a stall — that is an idle second of a rollout', () => {
    const r = assessConsumers({ waiting: 0, consumers: 0 });
    expect(r.stalled).toBe(false);
    expect(r.detail).toContain('idle, or a worker still starting');
  });

  it('the healthy case reads as healthy', () => {
    const r = assessConsumers({ waiting: 0, consumers: 2 });
    expect(r.stalled).toBe(false);
    expect(r.detail).toContain('2 consumer(s) attached');
  });
});

describe('P1-3: the report, end to end', () => {
  it('a server with the worker OFF and work queued reports the stall', async () => {
    process.env.POTION_WORKER = 'off';
    const { buildServer } = await import('../src/server.js');
    const queue = createMemoryQueue();
    const app: FastifyInstance = await buildServer({ seed: false, queue });
    try {
      expect(app.potionWorker).toBeNull(); // nothing registered a handler
      await queue.enqueue('eval:run', {});
      const report = await checkReadiness(app.potion);
      expect(report.consumers).toBeDefined();
      expect(report.consumers!.consumers).toBe(0);
      expect(report.consumers!.waiting).toBeGreaterThan(0);
      expect(report.consumers!.stalled).toBe(true);

      // AND READINESS STILL PASSES. A missing worker does not stop this
      // process serving; draining it from the load balancer would turn
      // "background work stopped" into "the product is down".
      expect(report.ok).toBe(true);
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json().consumers.stalled).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('the default server consumes, so nothing is ever reported stalled', async () => {
    delete process.env.POTION_WORKER;
    const { buildServer } = await import('../src/server.js');
    const app: FastifyInstance = await buildServer({ seed: false, queue: createMemoryQueue() });
    try {
      expect(app.potionWorker).not.toBeNull();
      const report = await checkReadiness(app.potion);
      expect(report.consumers!.consumers).toBeGreaterThan(0);
      expect(report.consumers!.stalled).toBe(false);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe('P1-3: the stall is alertable, not just readable', () => {
  it('the /metrics gauge carries it, sampled by the probe that already runs', async () => {
    // A field in a 200 body is something a human reads after suspecting a
    // problem. potion_queue_stalled is something a monitor notices without
    // one. /readyz is polled continuously by the load balancer, so the
    // sampling needs no timer of its own.
    process.env.POTION_WORKER = 'off';
    process.env.POTION_METRICS = '1';
    const { buildServer } = await import('../src/server.js');
    const queue = createMemoryQueue();
    const app: FastifyInstance = await buildServer({ seed: false, queue });
    try {
      await queue.enqueue('eval:run', {});
      await app.inject({ method: 'GET', url: '/readyz' });
      const text = await app.potion.observability!.metricsText();
      expect(text).toContain('potion_queue_stalled');
      expect(text).toMatch(/potion_queue_stalled\s+1/);
      expect(text).toMatch(/potion_queue_consumers\s+0/);
    } finally {
      delete process.env.POTION_METRICS;
      await app.close();
    }
  }, 60_000);
});

