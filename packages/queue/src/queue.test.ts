import { describe, expect, it } from 'vitest';
import { createQueue } from './index.js';
import { MemoryQueue } from './memory.js';

describe('memory queue', () => {
  it('processes jobs FIFO and returns unique ids', async () => {
    const q = createQueue('memory');
    const seen: Array<{ name: string; payload: unknown }> = [];
    q.registerHandler('email', async (payload) => {
      seen.push({ name: 'email', payload });
    });
    const ids = await Promise.all([
      q.enqueue('email', { n: 1 }),
      q.enqueue('email', { n: 2 }),
      q.enqueue('email', { n: 3 }),
    ]);
    await q.close();
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.startsWith('mem-'))).toBe(true);
    expect(seen.map((s) => s.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('holds jobs until a handler is registered, then drains', async () => {
    const q = createQueue('memory');
    await q.enqueue('late', 'a');
    await q.enqueue('late', 'b');
    const seen: string[] = [];
    q.registerHandler('late', async (payload) => {
      seen.push(payload as string);
    });
    await q.close();
    expect(seen).toEqual(['a', 'b']);
  });

  it('routes jobs to per-name handlers in order', async () => {
    const q = createQueue('memory');
    const a: number[] = [];
    const b: number[] = [];
    q.registerHandler('a', async (p) => {
      a.push(p as number);
    });
    q.registerHandler('b', async (p) => {
      b.push(p as number);
    });
    await q.enqueue('a', 1);
    await q.enqueue('b', 10);
    await q.enqueue('a', 2);
    await q.enqueue('b', 20);
    await q.close();
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([10, 20]);
  });

  it('rejects enqueue after close', async () => {
    const q = createQueue('memory');
    await q.close();
    await expect(q.enqueue('x', null)).rejects.toThrow(/closed/);
  });
});

describe('createQueue', () => {
  it('builds a bullmq driver (M3 #28) — see bullmq.test.ts for behavior', () => {
    // Driver selection: explicit kind wins; construction is lazy (no Redis
    // command is issued until enqueue/getJob), so this never touches a server.
    const q = createQueue('bullmq', 'redis://localhost:6399');
    expect(typeof q.enqueue).toBe('function');
    expect(typeof q.getJob).toBe('function');
    return q.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DRIVER PARITY (F10). The memory driver used to execute a throwing handler
// exactly once while production (bullmq) retried it 3× — SPEC.md §12.2 states
// the retry contract, and only one driver implemented it. That divergence did
// not merely leave a defect untested: it made the defect INEXPRESSIBLE, since
// every hermetic test uses this driver. These tests pin the semantics both
// drivers must agree on, so the next divergence fails the build instead of
// hiding a double-spend for months.
// ─────────────────────────────────────────────────────────────────────────────
describe('queue driver parity (F10)', () => {
  it('default is ONE execution — the historical memory-driver behavior, now explicit', async () => {
    const q = new MemoryQueue();
    let runs = 0;
    q.registerHandler('boom', async () => {
      runs += 1;
      throw new Error('always fails');
    });
    const id = await q.enqueue('boom', {});
    await q.close();
    expect(runs).toBe(1);
    const status = await q.getJob(id);
    expect(status?.state).toBe('failed');
    expect(status?.attempts).toBe(1);
  });

  it('attempts:3 models production — a throwing handler runs 3× then fails', async () => {
    // The bullmq equivalent is bullmq.test.ts "retries a throwing handler 3
    // times, then marks the job failed" (expect(attempts).toBe(3)). Same
    // assertion, same number, both drivers.
    const q = new MemoryQueue({ attempts: 3 });
    let runs = 0;
    q.registerHandler('boom', async () => {
      runs += 1;
      throw new Error('always fails');
    });
    const id = await q.enqueue('boom', {});
    await q.close();
    expect(runs).toBe(3);
    const status = await q.getJob(id);
    expect(status?.state).toBe('failed');
    expect(status?.attempts).toBe(3);
  });

  it('a handler that succeeds on attempt 2 completes, and the result is the successful run\'s', async () => {
    const q = new MemoryQueue({ attempts: 3 });
    let runs = 0;
    q.registerHandler('flaky', async () => {
      runs += 1;
      if (runs < 2) throw new Error('transient');
      return { ok: runs };
    });
    const id = await q.enqueue('flaky', {});
    await q.close();
    expect(runs).toBe(2);
    const status = await q.getJob(id);
    expect(status?.state).toBe('completed');
    expect(status?.result).toEqual({ ok: 2 });
  });

  it('DELIVERY CONTEXT: the handler is told the job id and which attempt it is', async () => {
    // This is what lets a handler tell a RETRY from a deliberate re-run —
    // the only available discriminator, since two verdicts for one tuple are
    // legitimate when a human asked twice.
    const q = new MemoryQueue({ attempts: 3 });
    const seen: Array<{ jobId: string; attempt: number }> = [];
    q.registerHandler('probe', async (_p, delivery) => {
      seen.push(delivery);
      if (seen.length < 3) throw new Error('again');
      return 'done';
    });
    const id = await q.enqueue('probe', {});
    await q.close();
    expect(seen.map((d) => d.attempt)).toEqual([1, 2, 3]);
    expect(new Set(seen.map((d) => d.jobId))).toEqual(new Set([id])); // ONE job id across attempts
  });
});
