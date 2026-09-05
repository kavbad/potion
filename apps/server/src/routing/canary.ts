// G2 rung 4b — THE CANARY SLICE (0093).
//
// Promoting a generation moves every request at once. A canary moves a
// FRACTION, so the evidence for promoting it comes from the org's own
// traffic rather than from a suite — the same argument the randomized
// holdout makes, applied to a routing change instead of a baseline.
//
// Mechanically it is one substitution: for a request in the slice, each
// cluster resolves to the CANDIDATE generation's frontier instead of the
// promoted one. Nothing else about serving changes, because a generation is
// a set of frontier pins and the load already knows how to honour one.
//
// Doctrine, all of it fail-safe:
//   · a candidate only — a promoted generation is not a canary, it is the
//     router;
//   · rate capped in the repo (CANARY_MAX_RATE), and re-clamped here, so a
//     value that reached the row another way still cannot move every
//     request onto unpromoted routing;
//   · any error at all, or a frontier the generation names that no longer
//     resolves, serves the promoted routing instead. A canary must never be
//     able to break serving;
//   · labeled where it lands — `;canary=<id>` on the trace and
//     `generation_id` on the ledger row — because a request routed by
//     something other than the promoted router must say so.
import { canaryingGeneration, CANARY_MAX_RATE, type GenerationPin, type PotionDb } from '@potion/db';
import type { PotionContext } from '../context.js';

/** Mirrors the holdout config cache: fresh enough that starting or stopping
 * a canary binds within a minute, cheap enough that serving never pays a
 * per-request read. The canary route busts it in-process. */
export const CANARY_CACHE_TTL_MS = 60_000;

interface CachedCanary {
  at: number;
  cfg: { generationId: string; rate: number; pins: Record<string, GenerationPin> } | null;
}

const cache = new Map<string, CachedCanary>();

export function bustCanaryCache(orgId: string): void {
  cache.delete(orgId);
}

async function configFor(db: PotionDb, orgId: string): Promise<CachedCanary['cfg']> {
  const hit = cache.get(orgId);
  if (hit !== undefined && Date.now() - hit.at < CANARY_CACHE_TTL_MS) return hit.cfg;
  let cfg: CachedCanary['cfg'] = null;
  try {
    const gen = await canaryingGeneration(db, orgId);
    cfg =
      gen === null
        ? null
        : { generationId: gen.id, rate: gen.canaryRate, pins: gen.pins as Record<string, GenerationPin> };
  } catch {
    cfg = null; // a config read failure never breaks serving — promoted routing
  }
  cache.set(orgId, { at: Date.now(), cfg });
  return cfg;
}

export interface CanaryDecision {
  generationId: string;
  /** cluster → the frontier this request must resolve to. */
  pins: Record<string, GenerationPin>;
}

/**
 * Decide whether THIS request rides the canary. Never throws into the
 * serving path; null = serve the promoted routing.
 */
export async function resolveCanary(
  ctx: PotionContext,
  orgId: string,
  opts: { rand?: () => number } = {},
): Promise<CanaryDecision | null> {
  try {
    const cfg = await configFor(ctx.db.db, orgId);
    if (cfg === null || cfg.rate <= 0) return null;
    const rand = opts.rand ?? Math.random;
    if (rand() >= Math.min(cfg.rate, CANARY_MAX_RATE)) return null;
    return { generationId: cfg.generationId, pins: cfg.pins };
  } catch {
    return null;
  }
}
