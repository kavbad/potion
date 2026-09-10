// P1-3 (external review, 2026-09-05): the worker was welded to the server.
//
// `buildServer` called `runWorker` unconditionally, so every server process
// was also a worker and there was no way to build one that was not. Node runs
// ONE event loop: a job with a synchronous stretch freezes every in-flight
// request for its duration — measured while building this, loop lag maxed at
// 2ms idle and 1188ms during a single in-process job, streaming responses
// included. The two halves also shared a heap, a memory limit and a fate.
//
// These pin the property that was missing: that the two halves CAN be run
// apart, that the split wiring is the same wiring, and that the one
// configuration which would silently swallow every job refuses to boot.
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryQueue } from '@potion/queue';
import { bootFatals, bootGateReport } from '../src/boot-report.js';
import { workerModeFromEnv, workerModeIsUnrecognized } from '../src/worker-runtime.js';

const SAVED = process.env.POTION_WORKER;
afterEach(() => {
  if (SAVED === undefined) delete process.env.POTION_WORKER;
  else process.env.POTION_WORKER = SAVED;
});

describe('P1-3: POTION_WORKER decides where jobs run', () => {
  const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

  it('unset keeps today behaviour — in-process, nobody has to opt in', () => {
    expect(workerModeFromEnv(env({}))).toBe('in-process');
  });

  it('EMPTY is unset, not off — the 2026-08-27 shape would have stopped every job', () => {
    expect(workerModeFromEnv(env({ POTION_WORKER: '' }))).toBe('in-process');
    expect(workerModeFromEnv(env({ POTION_WORKER: '   ' }))).toBe('in-process');
  });

  it('off, in every spelling an operator would reach for', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'none', ' off ']) {
      expect(workerModeFromEnv(env({ POTION_WORKER: v }))).toBe('off');
    }
  });

  it('an unrecognized value keeps the work HAPPENING, and says it did not understand', () => {
    // The other default would let a typo silently stop every research cycle,
    // guarantee sweep and alert dispatch on the box, with nothing failing.
    expect(workerModeFromEnv(env({ POTION_WORKER: 'yes-please' }))).toBe('in-process');
    expect(workerModeIsUnrecognized(env({ POTION_WORKER: 'yes-please' }))).toBe(true);
    expect(workerModeIsUnrecognized(env({ POTION_WORKER: 'off' }))).toBe(false);
    expect(workerModeIsUnrecognized(env({}))).toBe(false);
    const g = bootGateReport({ POTION_WORKER: 'yes-please', REDIS_URL: 'redis://x' }, 'live')
      .find((r) => r.name === 'POTION_WORKER')!;
    expect(g.warn).toContain('not a value this build');
  });
});

describe('P1-3: a server that consumes nothing, on a queue nobody can reach', () => {
  it('REFUSES to boot — the silent black hole is the whole risk', () => {
    // The memory driver is PROCESS-LOCAL. Enqueue into it with no in-process
    // worker and every job is accepted and dropped, forever, with nothing
    // anywhere erroring. No standalone worker can rescue it either.
    const rows = bootGateReport({ POTION_WORKER: 'off' }, 'live');
    const g = rows.find((r) => r.name === 'POTION_WORKER')!;
    expect(g.fatal).toContain('silently dropped');
    expect(bootFatals(rows).map((r) => r.name)).toContain('POTION_WORKER');
  });

  it('...but off with a SHARED queue is a legitimate deployment', () => {
    for (const shared of [{ REDIS_URL: 'redis://x' }, { QUEUE_DRIVER: 'bullmq' }]) {
      const rows = bootGateReport({ POTION_WORKER: 'off', ...shared }, 'live');
      expect(rows.find((r) => r.name === 'POTION_WORKER')!.fatal).toBeUndefined();
      expect(bootFatals(rows).map((r) => r.name)).not.toContain('POTION_WORKER');
    }
  });

  it('and the in-process default is never fatal, whatever the driver', () => {
    for (const e of [{}, { REDIS_URL: 'redis://x' }, { QUEUE_DRIVER: 'memory' }]) {
      expect(bootGateReport(e, 'live').find((r) => r.name === 'POTION_WORKER')!.fatal).toBeUndefined();
    }
  });
});

describe('P1-3: the split, end to end', () => {
  it('POTION_WORKER=off builds a server that consumes NOTHING', async () => {
    process.env.POTION_WORKER = 'off';
    const { buildServer } = await import('../src/server.js');
    // An injected queue: the caller owns it, so the memory-driver black-hole
    // gate correctly does not fire (that gate is about a queue this process
    // RESOLVED for itself and nobody else can reach).
    const app = await buildServer({ seed: false, queue: createMemoryQueue() });
    try {
      // The discriminator is the handle, not a handler count: registerHandler
      // overwrites by name, so "my handler ran" would have passed just as
      // happily with the server's own consumer sitting underneath it.
      expect(app.potionWorker).toBeNull();
    } finally {
      await app.close();
    }
  }, 60_000);

  it('the default consumes every job kind, in the SAME process', async () => {
    delete process.env.POTION_WORKER;
    const { buildServer } = await import('../src/server.js');
    const app = await buildServer({ seed: false, queue: createMemoryQueue() });
    try {
      expect(app.potionWorker).not.toBeNull();
      expect(app.potionWorker!.kinds.length).toBeGreaterThan(0);
      expect(app.potionWorker!.kinds).toContain('eval:run');
    } finally {
      await app.close();
    }
  }, 60_000);

  it('with the worker off the SERVER closes the queue, rather than abandoning it', async () => {
    // The worker owned the queue's close on the way out. With no worker,
    // something else has to, or a split deployment strands a Redis connection
    // on every restart.
    process.env.POTION_WORKER = 'off';
    const { buildServer } = await import('../src/server.js');
    const queue = createMemoryQueue();
    let closed = 0;
    const original = queue.close.bind(queue);
    queue.close = async () => {
      closed++;
      await original();
    };
    const app = await buildServer({ seed: false, queue });
    await app.close();
    expect(closed).toBe(1);
  }, 60_000);
});
