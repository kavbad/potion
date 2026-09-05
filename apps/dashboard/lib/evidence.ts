import { CLUSTERS as GENERATED_CLUSTERS, type LandingPoint as GeneratedPoint } from './evidence.generated';

// THE NUMBERS THE LANDING PAGE IS ALLOWED TO SAY.
//
// A marketing page is exactly where invented numbers go, so these are not
// invented: every one is derived from the committed platform baseline at
// packages/db/baseline/platform-frontiers.json — the same evidence the router
// selects from. They are hardcoded rather than fetched because the landing
// page is PUBLIC and must render with no session and no API server, and a
// number that silently becomes a dash is worse than one that is a little
// stale.
//
// Recompute after any campaign that republishes the baseline:
//
//   python3 -c "
//   import json; d=json.load(open('packages/db/baseline/platform-frontiers.json'))
//   pts=[p for f in d['frontiers'] for p in f['points']]
//   ms=set()
//   for p in pts:
//     sc=p['strategy_config']
//     for k in ('model','draftModel','verifierModel','startModel','upgradeModel','decomposerModel'):
//       if sc.get(k): ms.add(sc[k])
//     for m in sc.get('models',[]) or []: ms.add(m)
//   print(len(d['frontiers']), len(pts), len(ms), sum((p.get('evidence') or {}).get('n',0) for p in pts))"
//
export { EVIDENCE, BASELINE_META, CODE_GEN, CLUSTERS } from './evidence.generated';

/**
 * The honesty example, quoted verbatim from the same baseline.
 *
 * Two points on the rewrite-edit frontier. Their 95% intervals overlap almost
 * entirely (0.847-0.967 against 0.802-0.940), so the quality difference is not
 * resolved by the evidence — while the cheaper one is a third the price and
 * three and a half times faster. Potion reports them as tied and lets the
 * policy choose, which is the whole argument on one row.
 *
 * This is a REAL row. If a campaign republishes the baseline and these two
 * stop overlapping, this example must change with it or the page starts
 * lying — that is the cost of putting a measurement on a marketing page, and
 * it is the right cost to pay.
 */
export const TOO_CLOSE_EXAMPLE = {
  cluster: 'rewrite-edit',
  items: 14,
  strong: { label: 'or-sonnet', quality: 0.921, ci: 0.062, costPer1K: 4.5744, p95Ms: 5781 },
  cheap: { label: 'or-gpt-mini', quality: 0.879, ci: 0.072, costPer1K: 2.451, p95Ms: 2998 },
} as const;

// ---------------------------------------------------------------------------
// v10 landing data. Same discipline as EVIDENCE above: every row below is a
// REAL frontier point quoted from the committed baseline — hash, quality, CI,
// cost and p95 all verbatim. The landing page demos compute on these rows
// with the real policy semantics; nothing is staged.

export type { LandingPoint } from './evidence.generated';

/**
 * The interactive explorer ships the multi-step-reasoning frontier because it
 * is the one cluster whose evidence RESOLVES its own quality spread (0.46 to
 * 0.98 against CIs of ~0.13) — a 104x cost range where the trade-off is real,
 * not noise. n=50 items per point.
 */
export { EXPLORER } from './evidence.generated';

/**
 * Hero demo reel. The PROMPTS are authored examples; the ROUTE each one shows
 * — cluster, strategy, hash, cost, p95 — is the real frontier point that
 * cluster's policy would serve. The third entry routes UP to the expensive
 * model on purpose: routing is not a discount bin, it pays for quality where
 * the work demands it.
 */
export const ROUTE_DEMO = [
  { prompt: 'Is this review positive, negative, or neutral? \u2018Crashed twice, support never replied\u2026\u2019',
    cluster: 'classification', label: 'or-deepseek-v4-flash-0731', hash8: '1fd419ee', costPer1K: 0.0201, p95Ms: 10645, quality: 0.9875,
    note: 'cheapest point within a point of the perfect scorers' },
  { prompt: 'Write a function that merges overlapping date ranges, exclusive of endpoints.',
    cluster: 'code-gen', label: 'or-████████████', hash8: '220a2558', costPer1K: 0.0231, p95Ms: 15351, quality: 0.9785,
    note: "99% of the top model's quality at 1/270th the price. The name is the product." },
  { prompt: 'Extract invoice number, total, due date and line items from this document.',
    cluster: 'extraction', label: 'or-deepseek', hash8: '6efe8a56', costPer1K: 0.1846, p95Ms: 11344, quality: 0.9504,
    note: 'a twentieth the cost of the premium pick, inside its error bars' },
  { prompt: 'Using the attached support articles, can a Pro license transfer between workspaces?',
    cluster: 'rag-answer', label: 'or-ling-3.0-flash', hash8: 'e4263e18', costPer1K: 0.008, p95Ms: 1660, quality: 0.96,
    note: 'good enough here costs under a cent per thousand requests' },
  { prompt: 'An item lists for $88 with a coupon valid only above $70 after discount. Final price?',
    cluster: 'multi-step-reasoning', label: 'or-deepseek-v4-flash-0731', hash8: '1fd419ee', costPer1K: 0.0304, p95Ms: 9702, quality: 0.98,
    note: 'cheap models used to fail this work; the newest measurement found one that does not' },
  { prompt: 'Write three warm sentences of product copy for a handmade ceramic mug.',
    cluster: 'creative', label: 'or-sonnet', hash8: '07b4dc72', costPer1K: 7.56, p95Ms: 9464, quality: 0.9071,
    note: 'full price: nothing cheaper measures good enough, and the receipt says so' },
] as const;
// REAL frontier points per demo cluster, DERIVED from the committed baseline
// by scripts/gen-landing-evidence.ts. These rows used to be transcribed here
// with ci: 0 on every point — the intervals were real in the baseline and
// flattened to zero in the copy. They now carry their measured CIs.
const DEMO_CLUSTERS = ['classification', 'code-gen', 'extraction', 'rag-answer', 'multi-step-reasoning', 'creative'] as const;
export const FIELD: Record<string, GeneratedPoint[]> = Object.fromEntries(
  DEMO_CLUSTERS.map((c) => [c, GENERATED_CLUSTERS[c]!.points]),
);
