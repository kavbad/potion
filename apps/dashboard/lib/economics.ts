// THE ECONOMICS BEHIND THE LANDING PAGE'S SAVINGS CLAIM.
//
// Every (quality, cost) pair below is a REAL measured point from the committed
// platform frontier — packages/db/baseline/platform-frontiers.json, the same
// evidence the router selects from. The page computes savings in the browser
// from these rows using the router's real min_cost rule, so the number a
// visitor sees is derived, never typed.
//
// Recompute after any campaign that republishes the baseline: see the script
// in lib/evidence.ts, extended to emit {q, c} per point per cluster.
//
// THE BASELINE THIS COMPARES AGAINST, stated plainly because a savings claim
// is a claim about money: "premium" is the HIGHEST-QUALITY point on each
// cluster's frontier — i.e. what "just use the best model" actually costs.
// "Routed" is the cheapest point that still clears the quality floor. The
// blended figure weights all ten workload types equally, which is an
// assumption about traffic mix, not a measurement of anyone's traffic. The
// page says so.

export interface EconPoint {
  /** Measured quality, 0..1. */
  q: number;
  /** USD per 1,000 requests. */
  c: number;
}

export interface EconCluster {
  id: string;
  /** Plain-language name — the taxonomy id means nothing to a non-engineer. */
  name: string;
  points: EconPoint[];
}

export const ECONOMICS: EconCluster[] = [
  { id: 'agentic-tool-use', name: 'Agents using tools', points: [{ q: 0.8929, c: 6.4324 }, { q: 0.9071, c: 6.5689 }, { q: 0.9429, c: 7.1944 }, { q: 0.9571, c: 11.7154 }, { q: 0.9571, c: 13.7965 }, { q: 0.9714, c: 45.4076 }] },
  { id: 'classification', name: 'Sorting and tagging', points: [{ q: 0.975, c: 0.0041 }, { q: 0.9875, c: 0.0201 }, { q: 0.9875, c: 0.0263 }, { q: 0.9875, c: 0.0354 }, { q: 1, c: 0.358 }, { q: 1, c: 0.5378 }] },
  { id: 'code-gen', name: 'Writing code', points: [{ q: 0.9785, c: 0.0231 }, { q: 0.5759, c: 0.1232 }, { q: 0.98, c: 0.1904 }, { q: 0.7017, c: 0.2157 }, { q: 0.99, c: 0.2509 }, { q: 0.9961, c: 0.5506 }, { q: 1, c: 6.2568 }] },
  { id: 'code-review', name: 'Reviewing code', points: [{ q: 0.8143, c: 1.2644 }, { q: 0.9086, c: 1.5842 }, { q: 0.7943, c: 2.5043 }, { q: 0.9171, c: 2.8119 }, { q: 0.9529, c: 3.159 }] },
  { id: 'creative', name: 'Creative writing', points: [{ q: 0.4286, c: 3.8959 }, { q: 0.5571, c: 3.9706 }, { q: 0.8214, c: 4.0105 }, { q: 0.4286, c: 4.0719 }, { q: 0.7429, c: 4.9024 }, { q: 0.7857, c: 5.2254 }, { q: 0.8286, c: 5.5725 }, { q: 0.7929, c: 5.7032 }, { q: 0.9071, c: 7.56 }] },
  { id: 'extraction', name: 'Pulling data out of documents', points: [{ q: 0.9497, c: 0.0216 }, { q: 0.9504, c: 0.1846 }, { q: 0.9454, c: 0.2537 }, { q: 0.947, c: 0.3343 }, { q: 0.9733, c: 0.5931 }, { q: 0.9486, c: 1.2921 }, { q: 0.9587, c: 1.6493 }, { q: 0.9771, c: 1.7633 }, { q: 0.9782, c: 3.6813 }] },
  { id: 'multi-step-reasoning', name: 'Multi-step reasoning', points: [{ q: 0.5, c: 0.0093 }, { q: 0.98, c: 0.0304 }, { q: 0.76, c: 0.0845 }, { q: 0.56, c: 0.1482 }, { q: 0.66, c: 0.1656 }, { q: 0.92, c: 0.1906 }, { q: 1, c: 0.2929 }, { q: 0.94, c: 0.5657 }, { q: 0.96, c: 1.6482 }] },
  { id: 'rag-answer', name: 'Answering from your documents', points: [{ q: 0.92, c: 0.0059 }, { q: 0.96, c: 0.008 }, { q: 0.98, c: 0.0273 }, { q: 0.94, c: 0.0455 }, { q: 0.98, c: 0.0961 }] },
  { id: 'rewrite-edit', name: 'Rewriting and editing', points: [{ q: 0.7, c: 2.3255 }, { q: 0.8786, c: 2.451 }, { q: 0.8857, c: 3.9357 }, { q: 0.9214, c: 4.5744 }, { q: 0.9571, c: 31.4779 }] },
  { id: 'summarization', name: 'Summarising', points: [{ q: 0.8929, c: 2.1951 }, { q: 0.9286, c: 2.2125 }, { q: 0.9071, c: 2.3604 }, { q: 0.8, c: 2.3841 }, { q: 0.9429, c: 2.915 }, { q: 0.9714, c: 3.2124 }, { q: 0.9214, c: 3.2192 }, { q: 0.9714, c: 5.1389 }, { q: 0.9786, c: 10.8385 }, { q: 0.9714, c: 12.1838 }, { q: 0.9786, c: 42.7365 }] },
];

export interface ClusterSaving {
  cluster: EconCluster;
  premiumCost: number;
  routedCost: number | null;
  savedPct: number | null;
  /** True when no measured strategy clears the floor — we cannot serve it. */
  unmet: boolean;
}

/**
 * The router's real min_cost rule, applied at a floor: cheapest point at or
 * above the floor, compared against the highest-quality point.
 *
 * Returns `unmet` when nothing clears the floor — which the page renders
 * rather than hides. A savings model that claims a win in every category is
 * a savings model nobody should believe.
 */
export function savingsAt(floor: number): ClusterSaving[] {
  return ECONOMICS.map((cluster) => {
    const premium = cluster.points.reduce((a, b) =>
      b.q > a.q || (b.q === a.q && b.c < a.c) ? b : a,
    );
    const qualifying = cluster.points.filter((p) => p.q >= floor);
    if (qualifying.length === 0) {
      return { cluster, premiumCost: premium.c, routedCost: null, savedPct: null, unmet: true };
    }
    const routed = qualifying.reduce((a, b) => (b.c < a.c ? b : a));
    return {
      cluster,
      premiumCost: premium.c,
      routedCost: routed.c,
      savedPct: premium.c > 0 ? (1 - routed.c / premium.c) * 100 : 0,
      unmet: false,
    };
  });
}

/** Blended across the workload types Potion can serve at this floor. */
export function blendedSavingPct(rows: ClusterSaving[]): number {
  const served = rows.filter((r) => !r.unmet);
  const premium = served.reduce((s, r) => s + r.premiumCost, 0);
  const routed = served.reduce((s, r) => s + (r.routedCost ?? 0), 0);
  return premium > 0 ? (1 - routed / premium) * 100 : 0;
}

/** Highest-quality measured point for a workload — "the premium option".
 *  What "just use the best model" would pay on this kind of work. */
export function premiumCostFor(clusterId: string): number | null {
  const c = ECONOMICS.find((e) => e.id === clusterId);
  if (!c) return null;
  return c.points.reduce((a, b) => (b.q > a.q || (b.q === a.q && b.c < a.c) ? b : a)).c;
}

/** Cheapest measured point for a workload, whatever its quality. */
export function cheapestCostFor(clusterId: string): number | null {
  const c = ECONOMICS.find((e) => e.id === clusterId);
  if (!c) return null;
  return c.points.reduce((a, b) => (b.c < a.c ? b : a)).c;
}
