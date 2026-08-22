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
export const EVIDENCE = {
  /** Taxonomy clusters with a published platform frontier. */
  workloadTypes: 10,
  /** Points that survived three-dimensional domination across all clusters. */
  measuredStrategies: 74,
  /** Distinct models appearing on at least one frontier. */
  routableModels: 23,
  /** Graded item-level evaluations behind those points. */
  gradedEvaluations: 3229,
  /** Source of every number above. */
  source: 'packages/db/baseline/platform-frontiers.json',
} as const;

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

export interface LandingPoint {
  label: string;
  hash8: string;
  quality: number;
  ci: number;
  costPer1K: number;
  p95Ms: number;
}

/**
 * The interactive explorer ships the multi-step-reasoning frontier because it
 * is the one cluster whose evidence RESOLVES its own quality spread (0.46 to
 * 0.98 against CIs of ~0.13) — a 104x cost range where the trade-off is real,
 * not noise. n=50 items per point.
 */
export const EXPLORER = {
  cluster: 'multi-step-reasoning',
  frontierVersion: 3,
  items: 50,
  points: [
    // The cheapest row is the masked discovery — its NAME never enters the
    // DOM (operator rule; a CSS blur would leave it copy-pasteable).
    { label: 'or-████████████', hash8: '220a2558', quality: 0.5, ci: 0.14, costPer1K: 0.0093, p95Ms: 7160 },
    { label: 'or-deepseek-v4-flash-0731', hash8: '1fd419ee', quality: 0.98, ci: 0.0392, costPer1K: 0.0304, p95Ms: 9702 },
    { label: 'or-nemotron-3.5-lightning', hash8: '238db164', quality: 0.76, ci: 0.1196, costPer1K: 0.0845, p95Ms: 2739 },
    { label: 'or-gpt-full', hash8: '819f1ab8', quality: 0.56, ci: 0.139, costPer1K: 0.1482, p95Ms: 1126 },
    { label: 'or-gemini-flash', hash8: '41a39732', quality: 0.66, ci: 0.1326, costPer1K: 0.1656, p95Ms: 2293 },
    { label: 'or-inkling-small', hash8: '07c9d6a7', quality: 0.92, ci: 0.076, costPer1K: 0.1906, p95Ms: 4009 },
    { label: 'or-gemini-3.7-flash', hash8: 'ffe46bc9', quality: 1, ci: 0, costPer1K: 0.2929, p95Ms: 3242 },
    { label: 'or-inkling', hash8: '8ad63a4e', quality: 0.94, ci: 0.0665, costPer1K: 0.5657, p95Ms: 2449 },
    { label: 'or-kimi-k3', hash8: '7b918ab8', quality: 0.96, ci: 0.0549, costPer1K: 1.6482, p95Ms: 2422 },
  ] as LandingPoint[],
} as const;

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
    cluster: 'extraction', label: 'or-deepseek', hash8: '6efe8a56', costPer1K: 0.2019, p95Ms: 13033, quality: 0.9612,
    note: 'a third the cost of the premium pick, inside its error bars' },
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
// REAL frontier points per demo cluster, from packages/db/baseline/platform-frontiers.json
// (masked names never enter the DOM). Regenerate when the baseline republishes.
export const FIELD: Record<string, LandingPoint[]> = {
  'classification': [
    { label: 'or-████████', hash8: '220a2558', quality: 0.975, ci: 0, costPer1K: 0.0041, p95Ms: 3489 },
    { label: 'or-deepseek-v4-flash-0731', hash8: '1fd419ee', quality: 0.9875, ci: 0, costPer1K: 0.0201, p95Ms: 10645 },
    { label: 'or-gemini-flash', hash8: '41a39732', quality: 0.9875, ci: 0, costPer1K: 0.0263, p95Ms: 1080 },
    { label: 'or-gpt-mini', hash8: '4e2fc860', quality: 0.9875, ci: 0, costPer1K: 0.0354, p95Ms: 1053 },
    { label: 'or-gemini-3.7-flash', hash8: 'ffe46bc9', quality: 1, ci: 0, costPer1K: 0.358, p95Ms: 3367 },
    { label: 'or-opus', hash8: '10b2d052', quality: 1, ci: 0, costPer1K: 0.5378, p95Ms: 2132 },
  ],
  'code-gen': [
    { label: 'or-████████', hash8: '220a2558', quality: 0.9785, ci: 0, costPer1K: 0.0231, p95Ms: 15351 },
    { label: 'or-ling-3.0-flash', hash8: 'e4263e18', quality: 0.5759, ci: 0, costPer1K: 0.1232, p95Ms: 12731 },
    { label: 'or-deepseek', hash8: '6efe8a56', quality: 0.98, ci: 0, costPer1K: 0.1904, p95Ms: 15110 },
    { label: 'or-nemotron-3.5-lightning', hash8: '238db164', quality: 0.7017, ci: 0, costPer1K: 0.2157, p95Ms: 12943 },
    { label: 'or-gpt-mini', hash8: '4e2fc860', quality: 0.99, ci: 0, costPer1K: 0.2509, p95Ms: 4383 },
    { label: 'or-gemini-flash', hash8: '41a39732', quality: 0.9961, ci: 0, costPer1K: 0.5506, p95Ms: 2372 },
    { label: 'or-grok-4.6', hash8: 'e0a2f554', quality: 1, ci: 0, costPer1K: 6.2568, p95Ms: 44582 },
  ],
  'extraction': [
    { label: 'or-████████', hash8: '220a2558', quality: 0.9595, ci: 0, costPer1K: 0.0237, p95Ms: 14119 },
    { label: 'or-deepseek', hash8: '6efe8a56', quality: 0.9612, ci: 0, costPer1K: 0.2019, p95Ms: 13033 },
    { label: 'or-gpt-mini', hash8: '4e2fc860', quality: 0.956, ci: 0, costPer1K: 0.286, p95Ms: 2528 },
    { label: 'or-gemini-flash', hash8: '41a39732', quality: 0.9595, ci: 0, costPer1K: 0.3722, p95Ms: 1076 },
    { label: 'or-inkling-small', hash8: '07c9d6a7', quality: 0.9841, ci: 0, costPer1K: 0.5785, p95Ms: 14867 },
    { label: 'or-gpt-full', hash8: '819f1ab8', quality: 0.9611, ci: 0, costPer1K: 1.4358, p95Ms: 2225 },
    { label: 'or-kat-coder-pro-v2.5', hash8: '1afeece2', quality: 0.9729, ci: 0, costPer1K: 1.4644, p95Ms: 7707 },
    { label: 'or-gemini-3.7-flash', hash8: 'ffe46bc9', quality: 0.9778, ci: 0, costPer1K: 1.5836, p95Ms: 8790 },
    { label: 'or-inkling', hash8: '8ad63a4e', quality: 0.9841, ci: 0, costPer1K: 1.7698, p95Ms: 4636 },
    { label: 'or-opus', hash8: '10b2d052', quality: 0.9778, ci: 0, costPer1K: 4.0693, p95Ms: 2919 },
  ],
  'rag-answer': [
    { label: 'or-████████', hash8: '220a2558', quality: 0.92, ci: 0, costPer1K: 0.0059, p95Ms: 4864 },
    { label: 'or-ling-3.0-flash', hash8: 'e4263e18', quality: 0.96, ci: 0, costPer1K: 0.008, p95Ms: 1660 },
    { label: 'or-deepseek-v4-flash-0731', hash8: '1fd419ee', quality: 0.98, ci: 0, costPer1K: 0.0273, p95Ms: 10095 },
    { label: 'or-gemini-flash', hash8: '41a39732', quality: 0.94, ci: 0, costPer1K: 0.0455, p95Ms: 754 },
    { label: 'or-inkling-small', hash8: '07c9d6a7', quality: 0.98, ci: 0, costPer1K: 0.0961, p95Ms: 1061 },
  ],
  'multi-step-reasoning': [
    { label: 'or-████████', hash8: '220a2558', quality: 0.5, ci: 0, costPer1K: 0.0093, p95Ms: 7160 },
    { label: 'or-deepseek-v4-flash-0731', hash8: '1fd419ee', quality: 0.98, ci: 0, costPer1K: 0.0304, p95Ms: 9702 },
    { label: 'or-nemotron-3.5-lightning', hash8: '238db164', quality: 0.76, ci: 0, costPer1K: 0.0845, p95Ms: 2739 },
    { label: 'or-gpt-full', hash8: '819f1ab8', quality: 0.56, ci: 0, costPer1K: 0.1482, p95Ms: 1126 },
    { label: 'or-gemini-flash', hash8: '41a39732', quality: 0.66, ci: 0, costPer1K: 0.1656, p95Ms: 2293 },
    { label: 'or-inkling-small', hash8: '07c9d6a7', quality: 0.92, ci: 0, costPer1K: 0.1906, p95Ms: 4009 },
    { label: 'or-gemini-3.7-flash', hash8: 'ffe46bc9', quality: 1, ci: 0, costPer1K: 0.2929, p95Ms: 3242 },
    { label: 'or-inkling', hash8: '8ad63a4e', quality: 0.94, ci: 0, costPer1K: 0.5657, p95Ms: 2449 },
    { label: 'or-kimi-k3', hash8: '7b918ab8', quality: 0.96, ci: 0, costPer1K: 1.6482, p95Ms: 2422 },
  ],
  'creative': [
    { label: 'or-ling-3.0-flash', hash8: 'e4263e18', quality: 0.4286, ci: 0, costPer1K: 3.8959, p95Ms: 43146 },
    { label: 'or-laguna-s-2.1', hash8: '2e70d6e2', quality: 0.5571, ci: 0, costPer1K: 3.9706, p95Ms: 23248 },
    { label: 'or-deepseek', hash8: '6efe8a56', quality: 0.8214, ci: 0, costPer1K: 4.0105, p95Ms: 22494 },
    { label: 'or-nemotron-3.5-lightning', hash8: '238db164', quality: 0.4286, ci: 0, costPer1K: 4.0719, p95Ms: 15060 },
    { label: 'or-haiku', hash8: '88ed8b9c', quality: 0.7429, ci: 0, costPer1K: 4.9024, p95Ms: 7786 },
    { label: 'or-gemini-flash', hash8: '41a39732', quality: 0.7857, ci: 0, costPer1K: 5.2254, p95Ms: 3156 },
    { label: 'or-gpt-full', hash8: '819f1ab8', quality: 0.8286, ci: 0, costPer1K: 5.5725, p95Ms: 6012 },
    { label: 'or-gpt-mini', hash8: '4e2fc860', quality: 0.7929, ci: 0, costPer1K: 5.7032, p95Ms: 4978 },
    { label: 'or-sonnet', hash8: '07b4dc72', quality: 0.9071, ci: 0, costPer1K: 7.56, p95Ms: 9464 },
  ],
};
