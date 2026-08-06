// Graceful shutdown tests (M3 #27 HA, SPEC §12.8):
//   · in-flight request COMPLETES during the drain (real socket, real fetch)
//   · new requests are REJECTED once app.close() starts (connection refused)
//   · clean drain → exit(0); queue handle closed
//   · timeout cap → force exit(1)
//   · failed drain → force exit(1)
//   · double SIGTERM is safe (drain runs exactly once)
// processExit is always injected — the real exit never fires under vitest.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import {
  SHUTDOWN_TIMEOUT_MS,
  gracefulShutdown,
  installShutdownSignalHandlers,
} from '../src/shutdown.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Listen on an ephemeral port and return the base URL. */
async function listen(app: FastifyInstance): Promise<string> {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return address;
}

describe('gracefulShutdown (SPEC §12.8)', () => {
  it('drains an in-flight request to completion, closes the queue, exits 0', { timeout: 30_000 }, async () => {
    const app = await buildServer({ seed: false });
    cleanups.push(() => void app.close().catch(() => {}));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let handlerEntered = false;
    app.get('/slow', async () => {
      handlerEntered = true;
      await gate; // stays in-flight until the test releases it
      return { done: true };
    });
    const base = await listen(app);

    const inFlight = fetch(`${base}/slow`);
    // Wait until the handler is actually executing before starting the drain.
    while (!handlerEntered) await new Promise((r) => setTimeout(r, 5));

    const exits: number[] = [];
    let queueClosed = false;
    const shutdown = gracefulShutdown(app, app.potion, {
      processExit: (code) => exits.push(code),
      closeQueue: async () => {
        queueClosed = true;
      },
    });
    // The drain is now blocked on the in-flight request. Give close() a tick
    // to stop accepting, then prove NEW connections are refused.
    await new Promise((r) => setTimeout(r, 100));
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();

    release(); // let the in-flight request finish
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });

    await shutdown;
    expect(exits).toEqual([0]); // clean drain → exit 0
    expect(queueClosed).toBe(true);
  });

  it('force-exits 1 when the drain exceeds the timeout cap', async () => {
    const app = await buildServer({ seed: false });
    cleanups.push(() => void app.close().catch(() => {}));
    // Sabotage close(): the drain never completes.
    app.close = () => new Promise(() => {});
    const exits: number[] = [];
    const logs: string[] = [];
    await gracefulShutdown(app, app.potion, {
      timeoutMs: 50,
      processExit: (code) => exits.push(code),
      log: (msg) => logs.push(msg),
    });
    expect(exits).toEqual([1]);
    expect(logs.some((m) => m.includes('forcing exit 1'))).toBe(true);
  });

  it('force-exits 1 when the drain itself fails', async () => {
    const app = await buildServer({ seed: false });
    cleanups.push(() => void app.close().catch(() => {}));
    app.close = () => Promise.reject(new Error('close exploded'));
    const exits: number[] = [];
    await gracefulShutdown(app, app.potion, {
      processExit: (code) => exits.push(code),
      closeQueue: async () => {},
    });
    expect(exits).toEqual([1]);
  });

  it('defaults to a 30s cap', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(30_000);
  });
});

describe('installShutdownSignalHandlers (SIGTERM/SIGINT, SPEC §12.8)', () => {
  it('first signal drains + exits 0; a double signal is guarded (ignored)', async () => {
    const app = await buildServer({ seed: false });
    const exits: number[] = [];
    const logs: string[] = [];
    // handlers uninstall before the afterEach close runs
    const uninstall = installShutdownSignalHandlers(app, app.potion, {
      processExit: (code) => exits.push(code),
      log: (msg) => logs.push(msg),
      closeQueue: async () => {},
    });
    cleanups.push(uninstall);

    process.emit('SIGTERM');
    process.emit('SIGTERM'); // double-signal: must NOT start a second drain
    process.emit('SIGINT'); // a different signal during the drain is ignored too

    // Let the drain promise chain settle (app.close on a non-listening app
    // resolves quickly; exit is the last step).
    for (let i = 0; i < 200 && exits.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(exits).toEqual([0]);
    expect(logs.filter((m) => m.includes('received SIGTERM'))).toHaveLength(1);
    expect(logs.some((m) => m.includes('SIGTERM ignored'))).toBe(true);
    expect(logs.some((m) => m.includes('SIGINT ignored'))).toBe(true);
    uninstall();
  });
});
