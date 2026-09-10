// THE WORKER RUNTIME (P1-3, external review 2026-09-05) — the job-consuming
// half of Potion, extracted so it can run somewhere other than inside the
// process that answers /v1/chat/completions.
//
// WHY. `buildServer` called `runWorker` unconditionally, so every server was
// also a worker and there was no way to build one that was not. Node runs one
// event loop: a job with a synchronous stretch freezes every in-flight
// request for its duration. Measured on this machine — loop lag while idle
// max 2ms, loop lag during ONE in-process job max 1188ms. Streaming responses
// included. Beyond latency the two halves also share a heap, a memory limit,
// and a fate: an OOM in a research cycle takes serving down with it.
//
// WHAT THIS IS NOT. It is not a claim that in-process is wrong. On one small
// box it is the right default and stays the default (POTION_WORKER unset =>
// 'in-process'). What was wrong was that it was the ONLY option.
import type { ArtifactStore } from '@potion/artifacts';
import type { Metrics } from '@potion/observability';
import type { PotionQueue } from '@potion/queue';
import {
  createAlertsDispatchHandler,
  createBudgetEvaluateHandler,
  createGuaranteeEvaluateHandler,
  createOrgDeleteHandler,
  runWorker,
  type WorkerHandle,
} from '@potion/workers';
import { sendEmailFromEnv } from './email.js';
import type { PotionContext } from './context.js';

/** Where the job handlers run. */
export type WorkerMode = 'in-process' | 'off';

/**
 * POTION_WORKER: 'off' runs a server that ENQUEUES but never consumes —
 * for a deployment that runs `apps/server/dist/worker.js` as its own process.
 *
 * Unset or EMPTY keeps today's behaviour (in-process), so nothing changes for
 * anyone who does not opt in. Empty is treated as unset for the same reason as
 * everywhere else in this codebase: a scaffolded-empty variable is the
 * 2026-08-27 incident's own shape (see boot-report.ts).
 *
 * An UNRECOGNIZED value resolves to 'in-process' — the direction that keeps
 * background work happening — and the boot report names it. The opposite
 * default would let a typo silently stop every research cycle, guarantee
 * sweep and alert dispatch on the box, with nothing failing.
 */
export function workerModeFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerMode {
  const raw = env.POTION_WORKER?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'in-process';
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'none') return 'off';
  return 'in-process';
}

/** True when POTION_WORKER holds something this file does not understand. */
export function workerModeIsUnrecognized(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.POTION_WORKER?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return !['off', '0', 'false', 'none', 'in-process', 'in_process', 'inprocess', '1', 'true', 'on'].includes(raw);
}

export interface StartWorkerDeps {
  ctx: PotionContext;
  queue: PotionQueue;
  artifacts?: ArtifactStore | undefined;
  /** The observability meter — the same instance the server reports on. */
  meter: Metrics;
  /** Redacted failure sink for alert dispatch (the server passes app.log.warn). */
  log: (msg: string) => void;
}

/**
 * Register every job handler and start consuming. Moved VERBATIM out of
 * server.ts — the four handlers that are constructed here rather than taken
 * from @potion/workers' defaults are the ones that need something the plain
 * default cannot see (a meter, a log sink, an email transport, the serving
 * provider cache), and each keeps the comment explaining why.
 */
export async function startPotionWorker(deps: StartWorkerDeps): Promise<WorkerHandle> {
  const { ctx, queue, artifacts, meter, log } = deps;
  return runWorker({
    queue,
    db: ctx.db,
    // The worker holds the SAME prices path the context resolved — never its
    // own env/default fallback. A diverging worker is how the pre-S5 scan
    // writer (alive in any stale @potion/workers dist) reached the repo
    // prices.json while the context sat safely on a tmp copy.
    pricesPath: ctx.pricesPath,
    ...(artifacts !== undefined ? { artifacts } : {}),
    // M5 #36: traces:cluster embeds first-user-messages with the platform's
    // dimension-guarded embedder (mock by default, OpenAI post-M1b).
    embedder: ctx.embedder,
    handlers: {
      // ---- M3 #22 guarantee (m3-guarantee) ----
      'guarantee:evaluate': createGuaranteeEvaluateHandler({ meter }),
      // ---- G2.2 incident SLAs: alerts:dispatch with the latency meter +
      // the app log as the redacted failure sink (the default handler in
      // @potion/workers runs meter-less/log-less).
      'alerts:dispatch': createAlertsDispatchHandler({
        deps: {
          meter,
          log,
          // mailto: alert rules deliver through the same transport as
          // sign-in links (2026-08-24) — the 'nobody is watching' fix.
          sendEmail: (msg) =>
            Promise.resolve(
              sendEmailFromEnv().sendEmail({ to: msg.to, subject: msg.subject, text: msg.text }),
            ).then(() => undefined),
        },
      }),
      // ---- M4 #35 budget (m4-alerts-budget) ----
      'budget:evaluate': createBudgetEvaluateHandler({ meter }),
      // ---- G2.7 org deletion: cache invalidation after the cascade. In
      // process this keeps a revoked key from serving for a cache TTL after
      // its org is erased; in a SPLIT deployment the serving process has its
      // own cache, so this invalidates only the worker's copy — see
      // docs/DEPLOY-RUNBOOK.md.
      'org:delete': createOrgDeleteHandler({ onOrgDeleted: ctx.invalidateOrgProviders }),
    },
  });
}
