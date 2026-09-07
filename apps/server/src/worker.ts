// THE STANDALONE WORKER (P1-3, external review 2026-09-05).
//
// Consumes jobs and serves nothing. Run it beside a server started with
// POTION_WORKER=off, and background work stops sharing an event loop, a heap
// and a fate with /v1/chat/completions.
//
// It builds the SAME context the server builds — same db, same resolved
// prices path, same dimension-guarded embedder, same handler wiring — because
// a worker that resolves any of those differently from the server is the
// prices.json contamination class all over again. There is exactly one
// wiring, in worker-runtime.ts, and both processes call it.
//
// REQUIRES A SHARED QUEUE. With the memory driver a queue is process-local,
// so a split deployment on the memory driver enqueues into a queue nobody can
// reach. That combination refuses to boot rather than silently dropping every
// job — see boot-report.ts.
import { createArtifactStore } from '@potion/artifacts';
import { initObservability } from '@potion/observability';
import { createQueue, resolveQueueKind } from '@potion/queue';
import { buildContext } from './context.js';
import { startPotionWorker } from './worker-runtime.js';

const log = (msg: string) => console.log(`[potion-worker] ${msg}`);

const observability = initObservability({
  serviceName: 'potion-worker',
  ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? { otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }
    : {}),
  metrics: process.env.POTION_METRICS !== '0' && process.env.POTION_METRICS !== 'false',
});

// A process-local queue in a SEPARATE process is a contradiction: nothing
// this worker consumes could ever have been enqueued by the server. Refuse
// loudly rather than sit there looking healthy and consuming an empty queue
// forever — the mirror of the server's own boot gate for POTION_WORKER=off.
if (resolveQueueKind() === 'memory') {
  console.error(
    '[potion-worker] REFUSING TO START: the queue driver resolved to `memory`, which is ' +
      'process-local — nothing the server enqueues could ever reach this process. ' +
      'Set REDIS_URL (or QUEUE_DRIVER=bullmq) to share a queue, or drop the standalone ' +
      'worker and leave POTION_WORKER unset so the server consumes in-process.',
  );
  process.exit(1);
}

const ctx = await buildContext({ observability, log });
const queue = createQueue();
const artifacts =
  process.env.ARTIFACT_STORE === 'local' || process.env.ARTIFACT_STORE === 's3'
    ? createArtifactStore(process.env.ARTIFACT_STORE, {
        ...(process.env.ARTIFACT_DIR !== undefined ? { dir: process.env.ARTIFACT_DIR } : {}),
      })
    : undefined;

const worker = await startPotionWorker({
  ctx,
  queue,
  artifacts,
  meter: observability.meter,
  log: (m: string) => console.warn(`[potion-worker] ${m}`),
});
log(
  `consuming ${worker.kinds.length} job kinds` +
    (worker.researchScanIntervalHours !== null
      ? `; autoresearcher heartbeat every ${worker.researchScanIntervalHours}h`
      : '; autoresearcher heartbeat OFF'),
);

// KEEP THE PROCESS ALIVE, deliberately. A worker has no listening socket, so
// the only thing holding the event loop open would be the queue driver's own
// connection — an implicit dependency on a library's internals that already
// bit once here: on the memory driver this process booted, printed that it
// was consuming 24 job kinds, and exited a moment later with nothing left to
// do. This interval says out loud that the process is meant to stay up.
const keepAlive = setInterval(() => {}, 60_000);

// Drain in flight, then let the process go. SIGTERM is what `docker compose
// down` and a rolling deploy send; without this a redeploy kills a research
// cycle mid-spend.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepAlive);
    log(`${signal} — draining in-flight jobs`);
    void worker
      .close()
      .then(() => observability.shutdown())
      .then(() => (ctx.externalDb ? undefined : ctx.db.close()))
      .then(() => {
        log('drained');
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error('[potion-worker] shutdown failed', err);
        process.exit(1);
      });
  });
}
