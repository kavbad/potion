import { describe, expect, it } from 'vitest';
import { createQueue } from './index.js';

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
