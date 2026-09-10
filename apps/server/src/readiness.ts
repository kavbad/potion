// Readiness probe (SPEC §12.8, M3 #27 HA): GET /readyz answers 200 only when
// the instance can actually SERVE — db ping (`SELECT 1`) + queue ping
// (memory driver: always ok; bullmq: redis ping) — and always carries a
// circuit-breaker summary from @potion/providers. A failed check → 503 with
// per-check detail, so a load balancer can drain the instance.
//
// Contrast with /healthz, which stays "process up" (no dependencies).
//
// A TIMEOUT IS NOT AN OUTAGE (2026-09-06, found by load testing production).
//
// Caddy health-checks this endpoint every 10s and drains the upstream when it
// 503s. Under sustained load the db ping exceeded its 2s budget — not because
// the database was down, but because WE were busy — so /readyz reported
// unhealthy, Caddy pulled the only replica out of rotation, and 478 of 1500
// requests were answered with 503 by the proxy while the server sat there
// able to serve them. Load drained, the ping recovered, the instance came
// back, and the cycle repeated. The probe designed to protect the service was
// the thing taking it down, at roughly 15 rps.
//
// Draining a SATURATED instance is precisely the wrong move: with one replica
// it is a self-inflicted outage, and with several it moves that load onto the
// rest and cascades. Saturation already has correct, visible backpressure —
// 429s from the rate limiter and rising latency — and those are per-request
// signals a client can act on, which a health check is not.
//
// So the two failure modes are separated at the source:
//   · TIMEOUT (slow) → ok, `degraded: true`. Keep taking traffic; say so.
//   · ERROR (broken: refused, auth, bad query) → not ready. Drain, which is
//     what draining is for, and what deploy gating needs to stay strict.
//
// The 503 those requests received also never reached the route, so nothing
// was written to request_logs: the ledger showed 1072 ok and no failures for
// a window in which a third of traffic failed. Recording proxy-level refusals
// is a separate, still-open problem — this file can only stop causing them.
import { pingDb } from '@potion/db';
import { breakerStates, type BreakerState } from '@potion/providers';
import type { PotionContext } from './context.js';

export const READYZ_DB_TIMEOUT_MS = 2_000;
export const READYZ_QUEUE_TIMEOUT_MS = 2_000;

/** Thrown by `withTimeout` so a slow dependency is distinguishable from a
 *  broken one. The distinction is the whole point of this module. */
export class ProbeTimeoutError extends Error {
  readonly timeout = true as const;
  constructor(ms: number) {
    super(`timeout after ${ms}ms`);
    this.name = 'ProbeTimeoutError';
  }
}

export interface ReadinessCheck {
  /** Can this instance serve? A slow dependency does not make it false. */
  ok: boolean;
  /** Driver/probe identity (e.g. 'pglite', 'memory', 'bullmq'). */
  driver: string;
  /** The probe exceeded its budget: we are SLOW, not down. Still ok. */
  degraded?: true;
  /** Detail for a failed or degraded check. */
  detail?: string;
  latencyMs?: number;
}

export interface ReadinessReport {
  ok: boolean;
  /** TRUE when a probe timed out. The instance keeps taking traffic — this
   *  is the honest label for it, and what an operator should page on before
   *  it becomes an outage. */
  degraded?: true;
  checks: {
    db: ReadinessCheck;
    queue: ReadinessCheck;
  };
  /** Circuit-breaker states keyed by provider/model (empty = all closed). */
  breakers: Record<string, BreakerState>;
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
        timer = setTimeout(() => reject(new ProbeTimeoutError(ms)), ms);
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
    // Slow ≠ down. A ping that ran out of budget means this instance is busy;
    // draining it would remove capacity from a system that is short of it.
    if (err instanceof ProbeTimeoutError) {
      return { ok: true, degraded: true, driver: ctx.db.driver, detail: err.message };
    }
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
    if (err instanceof ProbeTimeoutError) {
      return { ok: true, degraded: true, driver, detail: err.message };
    }
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
  const [db, queue] = await Promise.all([
    checkDb(ctx, opts.dbTimeoutMs ?? READYZ_DB_TIMEOUT_MS, now),
    checkQueue(ctx, opts.queueTimeoutMs ?? READYZ_QUEUE_TIMEOUT_MS),
  ]);
  const degraded = db.degraded === true || queue.degraded === true;
  return {
    ok: db.ok && queue.ok,
    ...(degraded ? { degraded: true as const } : {}),
    checks: { db, queue },
    breakers: breakerStates(),
  };
}
