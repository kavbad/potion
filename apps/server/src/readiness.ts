// Readiness probe (SPEC §12.8, M3 #27 HA): GET /readyz answers 200 only when
// the instance can actually SERVE — db ping (`SELECT 1`, 2s timeout) + queue
// ping (memory driver: always ok; bullmq: redis ping) — and always carries a
// circuit-breaker summary from @potion/providers. Any failed check → 503
// with per-check detail, so a load balancer can drain the instance.
//
// Contrast with /healthz, which stays "process up" (no dependencies).
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
  const [db, queue] = await Promise.all([
    checkDb(ctx, opts.dbTimeoutMs ?? READYZ_DB_TIMEOUT_MS, now),
    checkQueue(ctx, opts.queueTimeoutMs ?? READYZ_QUEUE_TIMEOUT_MS),
  ]);
  return {
    ok: db.ok && queue.ok,
    checks: { db, queue },
    breakers: breakerStates(),
  };
}
