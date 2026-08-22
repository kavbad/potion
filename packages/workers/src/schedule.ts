// THE RESEARCH HEARTBEAT.
//
// The autoresearcher was fully built and never scheduled: `research:scan`
// detects newly launched models and fans out one `research:cycle` per new
// alias, and the only thing that ever triggered it was a human pressing a
// button. So the answer to "is mixing research running in the background?"
// was no — not because anything was missing, but because nothing called it.
//
// WHY A TIMER IS SAFE HERE, which is the whole design argument. The scan
// itself SPENDS NOTHING: it reads the provider's model list and diffs it
// against the registry. Money is only spent by the cycles it fans out, and a
// cycle is emitted ONLY for an alias that is genuinely new (capped by
// RESEARCH_SCAN_MAX_CYCLES), is bounded by its own per-cycle cap, and is
// refused against the org budget before any provider call. A scan on a
// quiet week therefore costs exactly $0 and enqueues nothing. That is what
// makes a heartbeat the right shape: it costs nothing to ask, and the
// frontier can only move when a model ships.
//
// OFF BY DEFAULT. An interval must be named explicitly — a deployment that
// says nothing gets the old behaviour, because turning on recurring spend
// is an operator decision, never a default someone discovers on their bill.
import type { Queue } from '@potion/queue';

/** Env knob: hours between scans. Unset, 0 or invalid ⇒ disabled. */
export const RESEARCH_SCAN_INTERVAL_ENV = 'POTION_RESEARCH_SCAN_INTERVAL_HOURS';

export interface ResearchScheduleOptions {
  queue: Pick<Queue, 'enqueue'>;
  /** Hours between scans. Omit to read RESEARCH_SCAN_INTERVAL_ENV. */
  intervalHours?: number;
  /** Also scan once shortly after start (default false — a restart loop
   *  should not become a scan loop, even though a scan is free). */
  scanOnStart?: boolean;
  source?: 'mock' | 'openrouter';
  /** Injected for tests; defaults to console. */
  log?: (message: string) => void;
  /** Injected for tests so no real timer is needed. */
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

export interface ResearchSchedule {
  /** Hours between scans, or null when the schedule is off. */
  intervalHours: number | null;
  stop: () => void;
}

function readIntervalHours(explicit?: number): number | null {
  const raw = explicit ?? Number(process.env[RESEARCH_SCAN_INTERVAL_ENV] ?? '');
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

const HOUR_MS = 3_600_000;

/**
 * Start the heartbeat. Returns a handle whose `stop()` is idempotent; the
 * caller (runWorker) wires it into its own close path so a shut-down worker
 * leaves no timer behind.
 *
 * Scans are serialised by a re-arming timeout rather than setInterval: a slow
 * enqueue must not let two scans overlap, and an interval that fires while
 * the previous tick is still running is exactly how a queue gets flooded.
 */
export function startResearchSchedule(opts: ResearchScheduleOptions): ResearchSchedule {
  const intervalHours = readIntervalHours(opts.intervalHours);
  const log = opts.log ?? ((m: string) => console.log(m));
  if (intervalHours === null) return { intervalHours: null, stop: () => {} };

  const timer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      // Never hold the process open for a heartbeat.
      if (typeof t === 'object' && 'unref' in t) t.unref();
      return { cancel: () => clearTimeout(t) };
    });

  let stopped = false;
  let handle: { cancel: () => void } | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await opts.queue.enqueue('research:scan', {
        ...(opts.source !== undefined ? { source: opts.source } : {}),
      });
      log(`[research] scan enqueued (every ${intervalHours}h)`);
    } catch (e) {
      // A heartbeat must never take the worker down with it.
      log(`[research] scan enqueue failed, will retry next tick: ${(e as Error).message}`);
    }
    arm();
  };

  const arm = (): void => {
    if (stopped) return;
    handle = timer(() => void tick(), intervalHours * HOUR_MS);
  };

  if (opts.scanOnStart === true) {
    handle = timer(() => void tick(), 0);
  } else {
    arm();
  }

  log(`[research] heartbeat on — scanning for new models every ${intervalHours}h`);
  return {
    intervalHours,
    stop: () => {
      stopped = true;
      handle?.cancel();
      handle = null;
    },
  };
}
