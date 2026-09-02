// G1 RANDOMIZED INCUMBENT HOLDOUT (2026-09-01, the ladder's last G1 rung).
//
// Under EXPLICIT consent (default off, rate capped, always visible on the
// Savings page), a small randomized slice of eligible requests serves the
// org's NAMED incumbent instead of the router's pick. Two things nothing
// else can provide come from that slice:
//   · the LIVE BASELINE verified savings are measured against — measured
//     actuals on both sides, the billing basis pricing v2's
//     25%-of-verified-savings needs (bill the conservative lower bound,
//     never the estimate);
//   · the CAUSAL instrument for outcome-driven optimization — routing
//     otherwise decides which requests each strategy sees, so observational
//     outcome comparisons are confounded by construction.
//
// Eligibility, fail-closed:
//   · consent on AND rate > 0 (both org-set; the route caps rate ≤ 5%);
//   · no explicit pin (the customer naming a model outranks everything);
//   · default instrument only (a vision/audio request swapped onto a model
//     the constraint machinery never vetted would be a different request);
//   · the incumbent resolves in the price table, and under LIVE providers
//     never to the mock provider (a mock answer as a live baseline is the
//     false-live disease).
// The swap is labeled everywhere it lands: `;holdout=1` on the trace, the
// ledger's holdout column, baseline NULL (a baseline request never claims
// savings), router_version NULL (the router did not decide it).
import { getOrgIncumbents, type PotionDb } from '@potion/db';
import type { PotionContext } from '../context.js';

/** Hard ceiling on the slice — the consent copy promises "a small slice". */
export const HOLDOUT_MAX_RATE = 0.05;

/** Config cache TTL — mirrors the serving-latency cache: fresh enough that
 * a toggle binds within a minute, cheap enough that serving never pays a
 * per-request read. The settings route busts it in-process on write. */
export const HOLDOUT_CACHE_TTL_MS = 60_000;

interface CachedConfig {
  at: number;
  cfg: { consent: boolean; rate: number; models: string[] } | null;
}

const cache = new Map<string, CachedConfig>();

export function bustHoldoutCache(orgId: string): void {
  cache.delete(orgId);
}

async function configFor(db: PotionDb, orgId: string): Promise<CachedConfig['cfg']> {
  const hit = cache.get(orgId);
  if (hit !== undefined && Date.now() - hit.at < HOLDOUT_CACHE_TTL_MS) return hit.cfg;
  let cfg: CachedConfig['cfg'] = null;
  try {
    const inc = await getOrgIncumbents(db, orgId);
    cfg = inc === null ? null : { consent: inc.holdoutConsent, rate: inc.holdoutRate, models: inc.models };
  } catch {
    cfg = null; // a config read failure never breaks serving — no holdout
  }
  cache.set(orgId, { at: Date.now(), cfg });
  return cfg;
}

/** The org's holdout-eligible incumbent model, or null with the reason the
 * settings surface shows. Pure over (models, prices, mode). */
export function eligibleIncumbent(
  models: string[],
  prices: PotionContext['prices'],
  providerMode: PotionContext['providerMode'],
): { model: string } | { model: null; why: string } {
  for (const m of models) {
    const entry = prices.entries.find((e) => e.alias === m);
    if (entry === undefined) continue;
    if (providerMode === 'live' && entry.provider === 'mock') continue; // never a mock baseline on live
    return { model: m };
  }
  return {
    model: null,
    why:
      models.length === 0
        ? 'no incumbent designated'
        : 'no designated incumbent resolves to a servable priced model',
  };
}

export interface HoldoutDecision {
  model: string;
}

/**
 * Decide whether THIS request is a holdout. Never throws into the serving
 * path; null = serve normally.
 */
export async function resolveHoldout(
  ctx: PotionContext,
  orgId: string,
  opts: { pinned: boolean; instrument: string; rand?: () => number },
): Promise<HoldoutDecision | null> {
  if (opts.pinned) return null;
  if (opts.instrument !== 'default') return null;
  const cfg = await configFor(ctx.db.db, orgId);
  if (cfg === null || !cfg.consent || cfg.rate <= 0) return null;
  const incumbent = eligibleIncumbent(cfg.models, ctx.prices, ctx.providerMode);
  if (incumbent.model === null) return null;
  const rand = opts.rand ?? Math.random;
  if (rand() >= Math.min(cfg.rate, HOLDOUT_MAX_RATE)) return null;
  return { model: incumbent.model };
}
