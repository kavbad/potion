// THE LANDING PAGE'S NUMBERS, DERIVED — not transcribed.
//
// Why this script exists (2026-09-04). lib/evidence.ts carried the right
// doctrine in its header — "the landing page tracks committed evidence, not
// live state; re-quote when the baseline republishes" — and the doctrine is
// correct: a public page must render with no session and no API server, so
// the numbers have to be committed to the repo. What the doctrine lacked was
// a mechanism. Nobody re-quoted. The page went on saying "measured
// 2026-08-20" while extraction and code-review republished on 2026-09-03,
// and it printed the code-gen measurement date a day earlier than the
// frontier that produced it (v4, created 2026-08-21).
//
// So: same doctrine, same committed numbers, but generated. The landing
// quotes a file that is derived from the baseline by this script, and
// test/landing-evidence.test.ts fails the build when the two drift. Staleness
// is now loud instead of silent.
//
//   pnpm --filter @potion/dashboard gen:evidence
//
// THE WITHHELD WINNER. Which cheap model wins is the finding customers pay
// for, so its name never enters the DOM (operator, 2026-08-20 — a CSS blur
// would leave it copy-pasteable in the page source). The pattern below is
// the SAME one the server's incumbent roster uses
// (apps/server/src/incumbents/roster.ts) so there is one definition of the
// secret; the guard test asserts the generated file is clean.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const BASELINE = resolve(REPO, 'packages/db/baseline/platform-frontiers.json');
const PRICES = resolve(REPO, 'prices.json');
const OUT = resolve(HERE, '../lib/evidence.generated.ts');

/** Same pattern as the server's incumbent roster: the withheld winner. */
const WITHHELD = /solar|upstage/i;
/** The mask that ships instead of the name. */
const MASK = 'or-████████████';

/** The supplier relationship stays off the page (operator, 2026-08-20), so
 * the vendor shown is the model's maker, never the gateway it was bought
 * through. */
const VENDOR: Record<string, string> = {
  'x-ai': 'xAI',
  google: 'Google',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  anthropic: 'Anthropic',
  moonshotai: 'Moonshot',
  nvidia: 'NVIDIA',
  inclusionai: 'inclusionAI',
  thinkingmachines: 'Thinking Machines',
  poolside: 'Poolside',
  qwen: 'Qwen',
  'z-ai': 'Z.ai',
  bytedance: 'ByteDance',
  kwaipilot: 'Kwaipilot',
};

/** Suite item counts. The baseline records GRADED CELLS (evidence.n = items ×
 * repeats); the page says "30 items", which is the suite's size, not the cell
 * count. Both are true and they are not the same number, so both are emitted
 * and the captions choose. Read from the suite manifests so a resized suite
 * cannot silently keep an old count. */
function suiteItems(suiteId: string): number | null {
  for (const v of ['v2', 'v1']) {
    const dir = resolve(REPO, `packages/harness/suites/${v}/${suiteId}`);
    let manifest: { items?: unknown; itemCount?: number };
    try {
      manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as typeof manifest;
    } catch {
      continue; // suite not in this layout
    }
    if (typeof manifest.itemCount === 'number') return manifest.itemCount;
    if (Array.isArray(manifest.items)) return manifest.items.length;
    // The v2 layout points at a JSONL sidecar rather than inlining the items.
    if (typeof manifest.items === 'string') {
      try {
        const lines = readFileSync(resolve(dir, manifest.items), 'utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0);
        return lines.length;
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface StrategyConfig {
  type: string;
  model?: string;
  models?: string[];
  /** A cascade names its models per stage, not at the top level. */
  stages?: Array<{ model?: string }>;
  draftModel?: string;
  verifierModel?: string;
  startModel?: string;
  upgradeModel?: string;
  decomposerModel?: string;
}
interface RawPoint {
  quality: number;
  costPer1K: number;
  latencyP95: number;
  strategyHash: string;
  strategyConfig: StrategyConfig;
  evidence?: { n?: number; qualityCi95?: number; suiteId?: string };
}
interface RawFrontier {
  frontier: {
    cluster_id: string;
    version: number;
    created_at: string;
    prices_version: string;
    points: RawPoint[];
  };
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
  capturedAt: string;
  providerMode: string;
  frontiers: RawFrontier[];
};
const prices = JSON.parse(readFileSync(PRICES, 'utf8')) as {
  version: string;
  entries: Array<{ alias: string; provider: string; model: string }>;
};

/** alias → the model's maker, from the price table's native id. */
const vendorOf = new Map<string, string>();
for (const e of prices.entries) {
  // 'openrouter/x-ai/grok-4.6' → 'x-ai'; a direct 'anthropic' entry → itself.
  const path = `${e.provider}/${e.model}`.split('/');
  const maker = path.length >= 3 ? path[1]! : path[0]!;
  vendorOf.set(e.alias, VENDOR[maker] ?? '');
}

/** Every model a strategy names. Most points are a single model, but a
 * cascade names one per stage and the composite shapes name theirs in their
 * own fields — miss those and the "routable models" count is wrong AND a
 * withheld name could ride in unmasked through a shape nobody checked. */
function modelsOf(sc: StrategyConfig): string[] {
  const out: string[] = [];
  for (const k of ['model', 'draftModel', 'verifierModel', 'startModel', 'upgradeModel', 'decomposerModel'] as const) {
    const v = sc[k];
    if (v) out.push(v);
  }
  for (const m of sc.models ?? []) out.push(m);
  for (const st of sc.stages ?? []) if (st.model) out.push(st.model);
  return out;
}

/** The label a point ships under, masked when it is the withheld winner. A
 * multi-model strategy is labelled by its chain so the row says what ran. */
function labelOf(p: RawPoint): { label: string; vendor: string; masked: boolean } {
  const sc = p.strategyConfig;
  const models = modelsOf(sc);
  if (models.length === 0) return { label: sc.type, vendor: '', masked: false };
  const masked = models.some((m) => WITHHELD.test(m));
  const shown = models.map((m) => (WITHHELD.test(m) ? MASK : m));
  if (models.length > 1) {
    return { label: shown.join(' \u2192 '), vendor: sc.type, masked };
  }
  const only = models[0]!;
  if (WITHHELD.test(only)) return { label: MASK, vendor: 'name withheld', masked: true };
  return { label: only, vendor: vendorOf.get(only) ?? '', masked: false };
}

const round = (n: number, dp: number) => Number(n.toFixed(dp));

interface OutPoint {
  label: string;
  vendor: string;
  masked: boolean;
  hash8: string;
  quality: number;
  ci: number;
  costPer1K: number;
  p95Ms: number;
}

const clusters: Record<
  string,
  {
    version: number;
    measuredAt: string;
    suiteId: string;
    items: number | null;
    gradedCells: number;
    points: OutPoint[];
  }
> = {};

for (const { frontier: f } of baseline.frontiers) {
  const points: OutPoint[] = f.points
    .map((p) => {
      const { label, vendor, masked } = labelOf(p);
      return {
        label,
        vendor,
        masked,
        hash8: p.strategyHash.slice(0, 8),
        quality: round(p.quality, 4),
        ci: round(p.evidence?.qualityCi95 ?? 0, 4),
        costPer1K: round(p.costPer1K, 4),
        p95Ms: Math.round(p.latencyP95),
      };
    })
    .sort((a, b) => a.costPer1K - b.costPer1K);
  const suiteId = f.points[0]?.evidence?.suiteId ?? f.cluster_id;
  clusters[f.cluster_id] = {
    version: f.version,
    measuredAt: f.created_at.slice(0, 10),
    suiteId,
    items: suiteItems(suiteId),
    gradedCells: f.points[0]?.evidence?.n ?? 0,
    points,
  };
}

/** '1/271st the price' — the house formula, kept in step with lib/price-words
 * so the landing and the product speak one number. */
function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  const u = n % 10;
  return u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th';
}

// FIGURE 3 SHOWS THE ROWS ABOVE THE FLOOR, and says so.
//
// The hand-written figure drew five of code-gen's seven frontier points. That
// was an editorial pick with a real principle behind it that had never been
// written down: the two omitted points measure 0.58 and 0.70, far below any
// quality bar a customer would set, and the figure's whole argument is "the
// quality difference across this table is ~2 points". Draw all seven and that
// sentence becomes false — the spread is 42 points, not 2.1.
//
// So the filter is now explicit and derived: the figure shows the points at
// or above the 0.95 floor its own caption already names. On today's baseline
// that is exactly the five rows the page has always shown, but now for a
// stated reason, and the caption says how many were left out.
const FIGURE_FLOOR = 0.95;
const cgAll = clusters['code-gen']!;
const cg = { ...cgAll, points: cgAll.points.filter((p) => p.quality >= FIGURE_FLOOR) };
const belowFloor = cgAll.points.length - cg.points.length;
const cheapest = cg.points[0]!;
const dearest = cg.points[cg.points.length - 1]!;
const ratioExact = dearest.costPer1K / cheapest.costPer1K;
const ratio = Math.round(ratioExact);
const qualityGapPoints = round((dearest.quality - cheapest.quality) * 100, 1);
// Floored to one decimal, never rounded up: the page claimed "99% of its
// quality" against a measured 97.85%, which is the overstatement direction.
// Same rule as the pulse's kept-floors: a quality claim may understate, never
// overstate.
const qualityRetainedPct = Math.floor((cheapest.quality / dearest.quality) * 1000) / 10;

const newestMeasuredAt = Object.values(clusters)
  .map((c) => c.measuredAt)
  .sort()
  .reverse()[0]!;

const allPoints = Object.values(clusters).flatMap((c) => c.points);
// The two aggregate counts follow the recipe lib/evidence.ts documented in
// its header, so the generated numbers are comparable with the hand-computed
// ones they replace: DISTINCT MODELS across every strategy shape (a cascade
// contributes both of its stages), and the SUM of each point's own graded n
// (not cells x points — that double counts).
const routableModels = new Set(
  baseline.frontiers.flatMap(({ frontier: f }) => f.points.flatMap((p) => modelsOf(p.strategyConfig))),
).size;
const gradedEvaluations = baseline.frontiers.reduce(
  (sum, { frontier: f }) => sum + f.points.reduce((s, p) => s + (p.evidence?.n ?? 0), 0),
  0,
);

const header = `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by scripts/gen-landing-evidence.ts from the committed baseline at
// packages/db/baseline/platform-frontiers.json. Every number below is a real
// measurement; the withheld winner's name is masked here, at the source, so
// it cannot reach the DOM. Regenerate after any campaign that republishes
// the baseline:
//
//   pnpm --filter @potion/dashboard gen:evidence
//
// test/landing-evidence.test.ts fails if this file and the baseline disagree,
// if a withheld name appears, or if the landing's evidence goes stale past
// the freshness window.
`;

const body = `${header}
export interface LandingPoint {
  label: string;
  vendor: string;
  masked: boolean;
  hash8: string;
  quality: number;
  ci: number;
  costPer1K: number;
  p95Ms: number;
}

export interface LandingCluster {
  version: number;
  /** The day the frontier that produced these points was created. */
  measuredAt: string;
  suiteId: string;
  /** Distinct suite items, or null when the suite is not on disk. */
  items: number | null;
  /** Graded cells behind each point (items x repeats). */
  gradedCells: number;
  points: LandingPoint[];
}

/** Where these numbers come from, said on the page wherever they are shown. */
export const BASELINE_META = {
  source: 'packages/db/baseline/platform-frontiers.json',
  capturedAt: ${JSON.stringify(baseline.capturedAt.slice(0, 10))},
  pricesVersion: ${JSON.stringify(prices.version)},
  providerMode: ${JSON.stringify(baseline.providerMode)},
  /** The most recent frontier in the baseline — what "how fresh is this" means. */
  newestMeasuredAt: ${JSON.stringify(newestMeasuredAt)},
} as const;

/** Every published cluster frontier, cheapest point first. */
export const CLUSTERS: Record<string, LandingCluster> = ${JSON.stringify(clusters, null, 2)};

/** Figure 3 — the code-gen band. The headline ratio is DERIVED from the two
 * rows shown, so the prose and the bars can never disagree. */
export const CODE_GEN = {
  measuredAt: ${JSON.stringify(cg.measuredAt)},
  version: ${cg.version},
  suiteId: ${JSON.stringify(cg.suiteId)},
  items: ${JSON.stringify(cg.items)},
  gradedCells: ${cg.gradedCells},
  rows: CLUSTERS['code-gen']!.points.filter((p) => p.quality >= ${FIGURE_FLOOR}),
  /** The bar every drawn row clears, named in the caption. */
  floor: ${FIGURE_FLOOR},
  /** Frontier points omitted for measuring below that floor. Widened from its
   * literal type: it varies with the baseline, and callers compare it. */
  belowFloor: ${belowFloor} as number,
  maxCost: ${dearest.costPer1K},
  minCost: ${cheapest.costPer1K},
  /** ${ratioExact.toFixed(1)}x, rounded for prose. */
  ratio: ${ratio},
  ratioWords: ${JSON.stringify(`1/${ratio}${ordinal(ratio)} the price`)},
  qualityGapPoints: ${qualityGapPoints},
  qualityRetainedPct: ${qualityRetainedPct},
} as const;

/** Figure 5 — the interactive explorer runs on multi-step-reasoning: the one
 * cluster whose evidence resolves its own quality spread. */
export const EXPLORER = {
  cluster: 'multi-step-reasoning',
  frontierVersion: ${clusters['multi-step-reasoning']!.version},
  measuredAt: ${JSON.stringify(clusters['multi-step-reasoning']!.measuredAt)},
  items: ${clusters['multi-step-reasoning']!.gradedCells},
  points: CLUSTERS['multi-step-reasoning']!.points,
} as const;

/** The aggregate counts the page is allowed to say. */
export const EVIDENCE = {
  workloadTypes: ${Object.keys(clusters).length},
  measuredStrategies: ${allPoints.length},
  routableModels: ${routableModels},
  gradedEvaluations: ${gradedEvaluations},
  source: BASELINE_META.source,
} as const;
`;

// Last line of defence: the withheld name must not survive into the artifact.
if (WITHHELD.test(body)) {
  throw new Error('gen-landing-evidence: withheld model name reached the generated file — masking failed');
}

writeFileSync(OUT, body);
console.log(
  `wrote ${OUT}\n  clusters=${Object.keys(clusters).length} points=${allPoints.length} models=${routableModels}` +
    `\n  code-gen v${cg.version} measured ${cg.measuredAt}: ${ratioExact.toFixed(1)}x over ${qualityGapPoints} quality points` +
    `\n  newest frontier in baseline: ${newestMeasuredAt}`,
);
