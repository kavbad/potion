// Readiness probe (SPEC §12.8, M3 #27 HA): GET /readyz answers 200 only when
// the instance can actually SERVE — db ping (`SELECT 1`, 2s timeout) + queue
// ping (memory driver: always ok; bullmq: redis ping) — and always carries a
// circuit-breaker summary from @potion/providers. Any failed check → 503
// with per-check detail, so a load balancer can drain the instance.
//
// Contrast with /healthz, which stays "process up" (no dependencies).
//
// It also REPORTS, without gating on, whether anything is draining the job
// queue (P1-3). See assessConsumers for why that must not 503.
import { pingDb } from '@potion/db';
import { breakerStates, type BreakerState } from '@potion/providers';
import type { PotionContext } from './context.js';

export const READYZ_DB_TIMEOUT_MS = 2_000;
export const READYZ_QUEUE_TIMEOUT_MS = 2_000;

export interface ReadinessCheck {
  ok: boolean;
  /** Driver/probe identity (e.g. 'pglite', 'memory', 'bullmq'). */
  driver: string;
  /** Failure detail when ok=false (timeout message or db/driver error). */
  detail?: string;
  latencyMs?: number;
}

export interface ReadinessReport {
  ok: boolean;
  checks: {
    db: ReadinessCheck;
    queue: ReadinessCheck;
  };
  /** Circuit-breaker states keyed by provider/model (empty = all closed). */
  breakers: Record<string, BreakerState>;
  /**
   * P1-3 liveness: who is draining the queue. REPORTED, never gating — see
   * `ok` above and the comment on `assessConsumers`.
   */
  consumers?: ConsumerReport;
}

export interface ConsumerReport {
  /** Jobs accepted and not yet started. */
  waiting: number;
  /** Processes attached to the queue as consumers. */
  consumers: number;
  /** True when work is queued and nothing is there to run it. */
  stalled: boolean;
  detail: string;
}

/**
 * THE P1-3 GAP, CLOSED. A server started with POTION_WORKER=off enqueues and
 * never consumes; if the standalone worker is not running, jobs pile up in
 * Redis and nothing anywhere says so. The boot gate could not catch it — at
 * boot, "no worker attached yet" and "no worker will ever attach" look the
 * same. It is a RUNTIME condition, so it is answered at runtime.
 *
 * THE RULE: stalled = work is waiting AND nothing is attached to take it.
 * Both halves matter. Waiting alone is not a stall — one worker running a
 * 24-minute research cycle legitimately leaves the next job waiting, and a
 * check that fired on depth would be muted within a week. Zero consumers
 * alone is not a stall either: an idle queue with the worker still deploying
 * is a normal second of a rollout.
 *
 * IT MUST NOT FAIL /readyz. Readiness drains the instance from the load
 * balancer, and a missing WORKER does not stop this process SERVING — chat
 * requests are answered from the same frontier either way. Failing readyz
 * here would turn "background work stopped" into "the product is down",
 * which is a worse outage than the one being reported. It is surfaced in the
 * body and as a metric, where an alert belongs.
 */
export function assessConsumers(facts: { waiting: number; consumers: number }): ConsumerReport {
  const stalled = facts.waiting > 0 && facts.consumers === 0;
  return {
    ...facts,
    stalled,
    detail: stalled
      ? `${facts.waiting} job(s) waiting and NO consumer attached — nothing is running them. ` +
        `With POTION_WORKER=off the standalone worker (apps/server/dist/worker.js, or the ` +
        `compose 'worker' service under --profile split) is not up; otherwise the in-process ` +
        `worker died. Jobs are not lost, they are accumulating.`
      : facts.consumers === 0
        ? 'no consumer attached, and nothing waiting — idle, or a worker still starting'
        : `${facts.consumers} consumer(s) attached, ${facts.waiting} waiting`,
  };
}

/** Duck-typed: drivers that cannot answer simply do not report. */
async function checkConsumers(ctx: PotionContext): Promise<ConsumerReport | undefined> {
  const q = ctx.queue as undefined | { consumerHealth?: () => Promise<{ waiting: number; consumers: number }> };
  if (q?.consumerHealth === undefined) return undefined;
  try {
    const report = assessConsumers(await q.consumerHealth());
    // Alerting belongs on a metric, not on a field in a 200 body. /readyz is
    // polled continuously by the load balancer, so sampling here needs no
    // timer of its own — the probe that already runs is the sampler.
    ctx.observability?.meter.setQueueConsumers?.(report);
    return report;
  } catch {
    // A queue that cannot be asked is already reported by the queue check
    // above; do not double-fail, and do not invent a stall from an outage.
    return undefined;
  }
}

export interface ReadinessOptions {
  /** db ping timeout in ms (default 2_000 per SPEC §12.8). */
  dbTimeoutMs?: number;
  queueTimeoutMs?: number;
  now?: () => number;
}

/** Duck-typed queue handle (SPEC §7 Queue / §12.2 PotionQueue — structural,
 * so this works across both without importing the queue package's types):
 *   · nothing wired / memory driver → always ready (SPEC §12.8);
 *   · drivers exposing ping() (bullmq-style redis ping) → probed directly;
 *   · drivers exposing getJob() (§12.2 PotionQueue) → probed with a
 *     nonexistent-id lookup: free on memory, a redis round-trip on bullmq
 *     (surfaces QueueUnavailableError when redis is down). */
interface QueueLike {
  close(): Promise<void>;
  ping?: () => Promise<unknown>;
  getJob?: (id: string) => Promise<unknown>;
}

/** Nonexistent job id used as the bullmq/redis liveness probe. */
const QUEUE_PROBE_JOB_ID = 'readyz:probe:nonexistent';

function queueDriverName(queue: QueueLike): string {
  const raw = queue.constructor?.name ?? 'unknown';
  const lower = raw.toLowerCase();
  if (lower.includes('memory')) return 'memory';
  if (lower.includes('bullmq')) return 'bullmq';
  return raw;
}

async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDb(ctx: PotionContext, timeoutMs: number, now: () => number): Promise<ReadinessCheck> {
  const start = now();
  try {
    await withTimeout(pingDb(ctx.db.db), timeoutMs);
    return { ok: true, driver: ctx.db.driver, latencyMs: Math.max(0, Math.round(now() - start)) };
  } catch (err) {
    return { ok: false, driver: ctx.db.driver, detail: (err as Error).message };
  }
}

function queueOf(ctx: PotionContext): QueueLike | undefined {
  return (ctx as { queue?: QueueLike }).queue;
}

async function checkQueue(ctx: PotionContext, timeoutMs: number): Promise<ReadinessCheck> {
  const queue = queueOf(ctx);
  // No queue wired (pure serving boot): memory-driver semantics — nothing
  // external to ping, always ready (SPEC §12.8).
  if (!queue) return { ok: true, driver: 'memory' };
  const driver = queueDriverName(queue);
  const probe =
    typeof queue.ping === 'function'
      ? () => queue.ping!()
      : typeof queue.getJob === 'function'
        ? () => queue.getJob!(QUEUE_PROBE_JOB_ID)
        : null;
  // Memory driver (or a driver with no probe surface): in-process, always ok.
  if (!probe || driver === 'memory') return { ok: true, driver };
  try {
    await withTimeout(probe(), timeoutMs);
    return { ok: true, driver };
  } catch (err) {
    return { ok: false, driver, detail: (err as Error).message };
  }
}

/**
 * checkReadiness(ctx) — run both dependency probes CONCURRENTLY (each has
 * its own 2s timeout, so the probe never hangs past ~2s) and assemble the
 * /readyz payload. `ok` = every check ok.
 */
export async function checkReadiness(
  ctx: PotionContext,
  opts: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const now = opts.now ?? Date.now;
  const [db, queue, consumers] = await Promise.all([
    checkDb(ctx, opts.dbTimeoutMs ?? READYZ_DB_TIMEOUT_MS, now),
    checkQueue(ctx, opts.queueTimeoutMs ?? READYZ_QUEUE_TIMEOUT_MS),
    checkConsumers(ctx),
  ]);
  return {
    // `consumers` is deliberately absent from this conjunction.
    ok: db.ok && queue.ok,
    checks: { db, queue },
    breakers: breakerStates(),
    ...(consumers !== undefined ? { consumers } : {}),
  };
}
