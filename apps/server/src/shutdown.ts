// Graceful shutdown (SPEC §12.8, M3 #27 HA): SIGTERM/SIGINT → stop accepting
// new connections, drain in-flight requests (Fastify's app.close() awaits
// them), close queue/db handles, exit 0 on a clean drain — force-exit 1 when
// the 30s cap is exceeded. Signal handling guards against double-signal.
//
// processExit is injectable so tests can assert the exit-code path without
// killing the test runner.
import type { FastifyInstance } from 'fastify';
import type { PotionContext } from './context.js';

export const SHUTDOWN_TIMEOUT_MS = 30_000;

export interface GracefulShutdownOptions {
  /** Drain cap in ms (default 30_000 per SPEC §12.8); exceeded → exit(1). */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Injectable process exit (tests). Default: process.exit. */
  processExit?: (code: number) => void;
  /** Injectable queue close. Default: closes ctx.queue when the context
   * carries one (queue drivers expose close(), SPEC §7). */
  closeQueue?: () => Promise<void>;
}

/** Duck-typed queue handle carried on the context by the queue wiring. */
interface CloseableQueue {
  close(): Promise<void>;
}

async function defaultCloseQueue(ctx: PotionContext): Promise<void> {
  const queue = (ctx as { queue?: CloseableQueue }).queue;
  await queue?.close();
}

/**
 * gracefulShutdown(app, ctx, opts) — the drain sequence:
 *   1. app.close() stops accepting new requests and awaits in-flight ones;
 *      the server onClose hook then drains observability + closes the db
 *      handle (when server-owned).
 *   2. the queue handle is closed (memory driver drains; SPEC §7).
 *   3. exit(0) on a clean drain; if the timeout wins the race, exit(1)
 *      (force) so an orchestrator can reap the pod.
 */
export async function gracefulShutdown(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: GracefulShutdownOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const exit = opts.processExit ?? ((code: number) => process.exit(code));
  const closeQueue = opts.closeQueue ?? (() => defaultCloseQueue(ctx));

  log(`shutdown: draining in-flight requests (cap ${timeoutMs}ms)`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.(); // never keep the process alive for the watchdog alone
  });
  const drain = (async (): Promise<'drained'> => {
    const closing = app.close();
    // Fastify's default keepAliveTimeout (72s) exceeds the 30s drain cap:
    // close idle keep-alive sockets NOW and make sockets that finish
    // draining close immediately after their response, so app.close()
    // resolves as soon as in-flight work ends instead of lingering on
    // pooled client connections until the cap forces exit(1).
    app.server.closeIdleConnections?.();
    if (typeof app.server.keepAliveTimeout === 'number') app.server.keepAliveTimeout = 1;
    await closing;
    await closeQueue();
    return 'drained';
  })();
  // Surface drain rejections through the race (a failed close = failed drain).
  const result = await Promise.race([
    drain.then(
      (r) => ({ ok: true as const, result: r }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    timeout.then((r) => ({ ok: true as const, result: r })),
  ]);
  if (timer) clearTimeout(timer);

  if (result.ok && result.result === 'drained') {
    log('shutdown: clean drain — exiting 0');
    exit(0);
    return;
  }
  if (!result.ok) {
    log(`shutdown: drain failed (${(result.err as Error)?.message ?? result.err}) — forcing exit 1`);
  } else {
    log(`shutdown: drain exceeded ${timeoutMs}ms — forcing exit 1`);
  }
  exit(1);
}

/**
 * installShutdownSignalHandlers(app, ctx, opts) — production entry wiring
 * (src/index.ts). First SIGTERM/SIGINT starts the graceful drain; further
 * signals are logged and IGNORED (double-signal guard — the drain is already
 * bounded by the timeout). Returns an uninstall fn (tests).
 */
export function installShutdownSignalHandlers(
  app: FastifyInstance,
  ctx: PotionContext,
  opts: GracefulShutdownOptions = {},
): () => void {
  const log = opts.log ?? (() => {});
  let shuttingDown = false;
  const onSignal = (signal: 'SIGTERM' | 'SIGINT'): void => {
    if (shuttingDown) {
      log(`shutdown: ${signal} ignored (drain already in progress)`);
      return;
    }
    shuttingDown = true;
    log(`shutdown: received ${signal}`);
    void gracefulShutdown(app, ctx, opts);
  };
  const onSigterm = (): void => onSignal('SIGTERM');
  const onSigint = (): void => onSignal('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  return () => {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
  };
}
