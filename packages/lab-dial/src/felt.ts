// Felt samples — eval runs at dial points, through the ONE outbound module
// (touchpoint 1: ServingClient only). Rewritten after the pre-commit
// review (findings 4/5/10/11/12/14/15):
//   - the trace's fallback= and latency_violated= markers are PARSED and
//     carried; a divergent sample (wrong strategy, fallback-served, or
//     violation-labeled) is returned typed and NEVER cached — cache
//     poisoning prevention;
//   - the cap is FAIL-CLOSED: cost lookup is required for uncached calls,
//     unknown cost consumes the whole remaining cap, and the first call
//     projects a conservative floor;
//   - cache lookups happen BEFORE the cap gate (hits are free and never
//     blocked); truncation beyond the sweep bound is reported, not silent.
import { canonicalJson, sha256, type Policy } from '@potion/core';
import { requestLogs, type PotionDb } from '@potion/db';
import { eq } from 'drizzle-orm';
import type { ServingClient } from '@potion/lab-runtime';
import type { DialGap } from './gaps.js';

export const FELT_SWEEP_MAX_POSITIONS = 3;
/** Fail-closed sweep cap. Labeled constant; any LIVE felt leg additionally
 * requires the standing ATTESTED_ON gate. */
export const FELT_SWEEP_CAP_USD = 0.25;
/** Conservative projection floor for the first call of a sweep — a cap
 * below this cannot prove even one probe affordable. */
export const FELT_MIN_PROJECTION_USD = 0.01;

export interface Probe {
  text: string;
  probeHash: string;
}

/** "The user's own task", headlessly: derived deterministically from the
 * mission. Step 8 lets users supply real examples. */
export function missionProbe(mission: { goal: string; doneDefinition?: string }): Probe {
  const text =
    `${mission.goal}\n` +
    (mission.doneDefinition !== undefined ? `Done means: ${mission.doneDefinition}\n` : '') +
    'Produce your best single response.';
  return {
    text,
    probeHash: sha256(
      canonicalJson({ goal: mission.goal, doneDefinition: mission.doneDefinition ?? null }),
    ),
  };
}

export interface FeltSample {
  /** The trace's 8-char strategy prefix — named for what it IS (review
   * finding 14): compare against DialView.strategyHash.slice(0, 8). */
  strategyHash8: string;
  frontierVersion: number;
  /** Parsed from x-frontier-trace — mock feel is labeled, never laundered. */
  provenance: string;
  /** Serving's honesty markers, carried whole (review finding 4). */
  fallback: boolean;
  latencyViolated: boolean;
  output: string;
  costUsd: number | null;
  latencyMs: number;
  completionId: string;
  cached: boolean;
}

export interface FeltCacheRow extends FeltSample {
  orgId: string;
  probeHash: string;
  policyHash: string;
  frontierId: string;
}

export interface FeltCache {
  get(key: { orgId: string; probeHash: string; policyHash: string; frontierId: string }): Promise<FeltCacheRow | null>;
  put(row: FeltCacheRow): Promise<void>;
}

export interface FeltDeps {
  /** A client PINNED to the position's policy row. */
  clientFor: (policyRef: string) => ServingClient;
  cache: FeltCache;
  /** completionId → metered costUsd. REQUIRED (review finding 11): the cap
   * cannot be fail-closed without it. Production impl:
   * `requestLogCostLookup(db)`. */
  costLookup: (completionId: string) => Promise<number | null>;
  clock?: () => number;
}

/** The production cost lookup: the request_logs join by completion id. */
export function requestLogCostLookup(db: PotionDb): (completionId: string) => Promise<number | null> {
  return async (completionId: string) => {
    const rows = await db
      .select({ usage: requestLogs.usage })
      .from(requestLogs)
      .where(eq(requestLogs.completionId, completionId));
    const usage = rows[0]?.usage as { costUsd?: number } | undefined;
    return typeof usage?.costUsd === 'number' ? usage.costUsd : null;
  };
}

export interface FeltPositionRequest {
  orgId: string;
  probe: Probe;
  policy: Policy;
  policyRef: string;
  frontierId: string;
  /** The dial view's full strategy hash — divergence detection (review
   * finding 10). When present, a sample whose trace disagrees is returned
   * typed and NEVER cached. */
  expectedStrategyHash?: string;
}

export type FeltOutcome =
  | { ok: true; sample: FeltSample; divergent?: { reason: 'strategy-mismatch' | 'fallback-served' | 'latency-violated'; expected8?: string } }
  | { ok: false; error: string };

export function feltCacheKey(req: FeltPositionRequest): { orgId: string; probeHash: string; policyHash: string; frontierId: string } {
  return {
    orgId: req.orgId,
    probeHash: req.probe.probeHash,
    policyHash: sha256(canonicalJson(req.policy)),
    frontierId: req.frontierId,
  };
}

function parseTrace(trace: string): {
  strategyHash8: string;
  frontierVersion: number;
  provenance: string;
  fallback: boolean;
  latencyViolated: boolean;
} {
  return {
    strategyHash8: /strategy=([0-9a-f]+)/.exec(trace)?.[1] ?? '',
    frontierVersion: Number(/frontier=v(\d+)/.exec(trace)?.[1] ?? '0'),
    provenance: /provenance=([a-z]+)/.exec(trace)?.[1] ?? 'unknown',
    fallback: /(?:^|;)fallback=1/.test(trace),
    latencyViolated: /latency_violated=1/.test(trace),
  };
}

export async function feltPosition(req: FeltPositionRequest, deps: FeltDeps): Promise<FeltOutcome> {
  const key = feltCacheKey(req);
  const cached = await deps.cache.get(key);
  if (cached !== null) {
    return { ok: true, sample: { ...cached, cached: true } };
  }
  const clock = deps.clock ?? (() => performance.now());
  const client = deps.clientFor(req.policyRef);
  const t0 = clock();
  const res = await client.complete({ messages: [{ role: 'user', content: req.probe.text }] });
  const latencyMs = Math.max(Math.round(clock() - t0), 0);
  if (res.kind !== 'ok') {
    return { ok: false, error: res.kind === 'error' ? `${res.code}: ${res.detail}` : res.kind };
  }
  const trace = parseTrace(res.frontierTrace);
  const costUsd = await deps.costLookup(res.completionId);
  const sample: FeltSample = {
    strategyHash8: trace.strategyHash8,
    frontierVersion: trace.frontierVersion,
    provenance: trace.provenance,
    fallback: trace.fallback,
    latencyViolated: trace.latencyViolated,
    output: res.text,
    costUsd,
    latencyMs,
    completionId: res.completionId,
    cached: false,
  };
  // Divergence detection: a sample that is not the clean agreement of view
  // and serve is returned TYPED and NEVER cached (poison prevention).
  const expected8 = req.expectedStrategyHash?.slice(0, 8);
  let divergent: { reason: 'strategy-mismatch' | 'fallback-served' | 'latency-violated'; expected8?: string } | undefined;
  if (trace.fallback) {
    divergent = { reason: 'fallback-served', ...(expected8 !== undefined ? { expected8 } : {}) };
  } else if (trace.latencyViolated) {
    divergent = { reason: 'latency-violated', ...(expected8 !== undefined ? { expected8 } : {}) };
  } else if (expected8 !== undefined && trace.strategyHash8 !== expected8) {
    divergent = { reason: 'strategy-mismatch', expected8 };
  }
  if (divergent !== undefined) {
    return { ok: true, sample, divergent };
  }
  await deps.cache.put({ ...sample, ...key });
  return { ok: true, sample };
}

export interface FeltSweepResult {
  samples: Array<{ policyRef: string; outcome: FeltOutcome }>;
  gap?: Extract<DialGap, { code: 'felt-cap-reached' }>;
  /** Positions beyond FELT_SWEEP_MAX_POSITIONS — reported, never silent
   * (review finding 15). */
  dropped: number;
}

/** Sequential sweep, fail-closed: cache hits are resolved BEFORE the cap
 * gate (free, never blocked); uncached calls project conservatively
 * (max(last cost, floor)); an UNKNOWN metered cost consumes the whole
 * remaining cap — the sweep stops rather than spends unprovably. */
export async function feltSweep(
  positions: FeltPositionRequest[],
  deps: FeltDeps,
  capUsd: number = FELT_SWEEP_CAP_USD,
): Promise<FeltSweepResult> {
  const take = positions.slice(0, FELT_SWEEP_MAX_POSITIONS);
  const dropped = positions.length - take.length;
  const samples: FeltSweepResult['samples'] = [];
  let spent = 0;
  let lastCallCost = FELT_MIN_PROJECTION_USD;
  for (const pos of take) {
    // Cache first — hits cost nothing and are never blocked by the cap.
    const hit = await deps.cache.get(feltCacheKey(pos));
    if (hit !== null) {
      samples.push({ policyRef: pos.policyRef, outcome: { ok: true, sample: { ...hit, cached: true } } });
      continue;
    }
    if (spent + Math.max(lastCallCost, FELT_MIN_PROJECTION_USD) > capUsd) {
      return { samples, gap: { code: 'felt-cap-reached', sampled: samples.length, capUsd }, dropped };
    }
    const outcome = await feltPosition(pos, deps);
    samples.push({ policyRef: pos.policyRef, outcome });
    if (outcome.ok && !outcome.sample.cached) {
      if (outcome.sample.costUsd === null) {
        // Unknown metered cost: fail CLOSED — consume the remainder.
        spent = capUsd;
        lastCallCost = capUsd;
      } else {
        spent += outcome.sample.costUsd;
        lastCallCost = outcome.sample.costUsd;
      }
    }
  }
  return { samples, dropped };
}
