// The refusals that stand between a measured frontier and the serving chain.
//
// These lived inline in promote-frontier.ts, where nothing could test them —
// the script throws on a missing DB url at import time, so a test could not
// load it. That mattered: on 2026-09-08 a session promoted a
// multi-step-reasoning frontier measured at the AUGUST prices version over a
// live chain measured at a newer one, and no refusal existed to stop it. The
// promoted point served 3/10 and the chain fell back to a model 25x dearer.
//
// Each function returns the refusal MESSAGE, or null to allow. Returning the
// message rather than throwing is what makes them testable by name.

export interface PromotablePoint {
  strategyHash: string;
  providerMode?: string;
  quality?: number;
  evidence?: { runIds?: string[] };
}

export interface PromotionDoc {
  clusterId: string;
  instrument: string;
  pricesVersion: string;
  points: PromotablePoint[];
}

export interface ServingFrontier {
  version: number;
  pricesVersion: string;
  points: PromotablePoint[];
}

/**
 * Simulated evidence never rides a promotion into serving. The provenance
 * guard would block it at the serve path anyway; refusing here keeps the
 * chain clean rather than minting a version that can never serve.
 */
export function notLiveRefusal(doc: PromotionDoc): string | null {
  const notLive = doc.points.filter((p) => p.providerMode !== 'live');
  if (notLive.length === 0) return null;
  return (
    `REFUSED: ${notLive.length}/${doc.points.length} points are not provider_mode=live ` +
    `(${notLive.map((p) => p.strategyHash.slice(0, 8)).join(', ')}) — simulated evidence never promotes`
  );
}

/**
 * Idempotence is by EVIDENCE, not by strategy set. A re-sweep's whole purpose
 * is to replace stale evidence for the SAME strategies with fresh evidence,
 * so comparing only the strategy-hash set would refuse exactly the promotion
 * that matters. The signature folds in each point's measured quality and its
 * evidence run ids: a genuine re-measurement differs on both, while a true
 * accidental re-run of the same export is identical and still refused.
 */
export function evidenceSignature(points: PromotablePoint[]): string {
  return points
    .map((p) => `${p.strategyHash}:${p.quality ?? ''}:${(p.evidence?.runIds ?? []).slice().sort().join(',')}`)
    .sort()
    .join('|');
}

export function identicalEvidenceRefusal(current: ServingFrontier | null, doc: PromotionDoc): string | null {
  if (!current) return null;
  if (evidenceSignature(current.points) !== evidenceSignature(doc.points)) return null;
  return (
    `REFUSED: target already serves v${current.version} with the identical points AND evidence ` +
    `(same strategies, same quality, same run ids) — a re-run must not mint a no-op version`
  );
}

/**
 * THE PRICES BASIS MUST NOT CHANGE SILENTLY (2026-09-10).
 *
 * A frontier's cost axis is computed against one prices version. Promoting a
 * frontier measured at a DIFFERENT version over the chain that is serving
 * replaces one cost axis with another, and `min_cost` then compares numbers
 * that were never commensurable — it will happily pick a point that is only
 * cheaper because it was priced on a different day.
 *
 * This is deliberately NOT "refuse an older version". `pricesVersion` is a
 * descriptive string — `2026-08-04-or2+tranche-2026-08-19`, plus a `+r<hash>`
 * suffix once a recompute has folded in its own resolution — so while it
 * usually opens with a date it carries no total order, and a comparison that
 * pretended otherwise would be a guess wearing a guard's clothes. What IS
 * knowable is whether the basis changed at all, and a promotion that moves it
 * is exactly the event that wants a human.
 *
 * The override is per-invocation and must name itself; there is no way to set
 * it by accident.
 */
export const PRICES_OVERRIDE_ENV = 'POTION_PROMOTE_ACCEPT_PRICES_CHANGE';

export function pricesBasisRefusal(
  current: ServingFrontier | null,
  doc: PromotionDoc,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!current) return null; // a first frontier has no basis to contradict
  if (current.pricesVersion === doc.pricesVersion) return null;
  if (env[PRICES_OVERRIDE_ENV] === '1') return null;
  return (
    `REFUSED: ${doc.clusterId}/${doc.instrument} serves v${current.version} measured at prices ` +
    `"${current.pricesVersion}", and this file was measured at "${doc.pricesVersion}". A frontier's ` +
    `cost axis is only comparable within one prices version, so promoting across a change swaps the ` +
    `axis min_cost selects on. Re-measure at the serving basis, or set ${PRICES_OVERRIDE_ENV}=1 to ` +
    `promote deliberately.`
  );
}

/** Every refusal, in the order they should be reported. First hit wins. */
export function promotionRefusal(
  current: ServingFrontier | null,
  doc: PromotionDoc,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return (
    notLiveRefusal(doc) ?? identicalEvidenceRefusal(current, doc) ?? pricesBasisRefusal(current, doc, env)
  );
}
