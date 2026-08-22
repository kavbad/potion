// THE REPLAY ENGINE — mixing program rung 2 (docs/OBSERVATORY.md §4).
//
// Every model's answer to every held-out item is already in the cache, with
// its quality, its cost, and (from 2026-08-22) its confidence. Any mechanism
// whose DECISIONS depend only on those can be simulated offline, exactly,
// for free: thousands of candidate mixtures a week for the price of a join.
// Live measurement is reserved for the few that survive replay.
//
// What replay can and cannot know, stated honestly:
//   · oracle / vote / confidence-gated cascade / selector bounds — exact,
//     from cached quality + confidence.
//   · consensus-or-escalate — APPROXIMATE: the cache holds correctness, not
//     answer text, so "the two cheap models agree" is modelled as "same
//     correctness". Two different wrong answers are counted as agreement
//     (cost saved, quality 0). This overstates agreement, which UNDERSTATES
//     the recipe's quality and cost — a conservative bias, the right direction.
//   · anything that generates NEW text (critique-repair, compress-then-
//     answer, draft-verify) cannot be replayed; those go straight to the
//     live tier.
//
// Output is a ranked list of candidate recipes per cluster with the numbers
// a live audition would have to confirm. Nothing here publishes anything.

export interface Cell {
  /** 0..1 */
  quality: number;
  /** USD for this one item (the cell's usage cost). */
  costUsd: number;
  /** Producing stage's confidence, when the provider exposed it. */
  confidence?: number;
}

/** item → model → cell. Only items every listed model has answered are used. */
export type ClusterMatrix = Map<string, Map<string, Cell>>;

export interface ModelSummary {
  model: string;
  n: number;
  meanQuality: number;
  meanCostUsd: number;
  /** Fraction of cells that carried a confidence. */
  confidenceCoverage: number;
}

export type RecipeKind =
  | 'oracle'
  | 'vote3'
  | 'consensus-or-escalate'
  | 'confidence-gated-cascade';

export interface Recipe {
  kind: RecipeKind;
  models: string[];
  params?: Record<string, number>;
  n: number;
  meanQuality: number;
  meanCostUsd: number;
  /** vs the best single model on quality: positive = better. */
  qualityDeltaVsBestSingle: number;
  /** vs the best single model's cost: positive = cheaper (fraction). */
  costSavingVsBestSingle: number;
  /** Pareto-undominated vs every single: no single is at least as good AND at least as cheap. */
  frontierCandidate: boolean;
  /** The money case: at least as good as the best single AND cheaper. */
  cheaperAndAsGood: boolean;
  /** For oracle: the ceiling; for others: how much of the oracle gap is captured. */
  realizedOfOracle?: number;
  note?: string;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Items answered by ALL the named models. */
function commonItems(matrix: ClusterMatrix, models: string[]): string[] {
  const out: string[] = [];
  for (const [item, row] of matrix) if (models.every((m) => row.has(m))) out.push(item);
  return out.sort();
}

export function summarizeModels(matrix: ClusterMatrix): ModelSummary[] {
  const per = new Map<string, Cell[]>();
  for (const row of matrix.values()) for (const [m, c] of row) (per.get(m) ?? per.set(m, []).get(m)!).push(c);
  return [...per.entries()]
    .map(([model, cells]) => ({
      model,
      n: cells.length,
      meanQuality: mean(cells.map((c) => c.quality)),
      meanCostUsd: mean(cells.map((c) => c.costUsd)),
      confidenceCoverage: cells.filter((c) => c.confidence !== undefined).length / cells.length,
    }))
    .sort((a, b) => b.meanQuality - a.meanQuality || a.meanCostUsd - b.meanCostUsd);
}

function finish(
  kind: RecipeKind,
  models: string[],
  qualities: number[],
  costs: number[],
  singles: ModelSummary[],
  params?: Record<string, number>,
  note?: string,
  oracleQuality?: number,
): Recipe {
  const mq = mean(qualities);
  const mc = mean(costs);
  const best = singles[0]!;
  const frontierCandidate = singles.every((s) => !(s.meanQuality >= mq - 1e-9 && s.meanCostUsd <= mc + 1e-12));
  const cheaperAndAsGood = mq >= best.meanQuality - 1e-9 && mc < best.meanCostUsd;
  const r: Recipe = {
    kind,
    models,
    ...(params ? { params } : {}),
    n: qualities.length,
    meanQuality: mq,
    meanCostUsd: mc,
    qualityDeltaVsBestSingle: mq - best.meanQuality,
    costSavingVsBestSingle: best.meanCostUsd > 0 ? 1 - mc / best.meanCostUsd : 0,
    frontierCandidate,
    cheaperAndAsGood,
    ...(note ? { note } : {}),
  };
  if (oracleQuality !== undefined && kind !== 'oracle') {
    const gap = oracleQuality - best.meanQuality;
    r.realizedOfOracle = gap > 1e-9 ? Math.max(0, Math.min(1, (mq - best.meanQuality) / gap)) : 0;
  }
  return r;
}

/** Right whenever either is right; pays for both. The ceiling on any fusion of the pair. */
export function replayOracle(matrix: ClusterMatrix, a: string, b: string, singles: ModelSummary[]): Recipe | null {
  const items = commonItems(matrix, [a, b]);
  if (items.length < 2) return null;
  const q = items.map((i) => Math.max(matrix.get(i)!.get(a)!.quality, matrix.get(i)!.get(b)!.quality));
  const c = items.map((i) => matrix.get(i)!.get(a)!.costUsd + matrix.get(i)!.get(b)!.costUsd);
  return finish('oracle', [a, b], q, c, singles, undefined, 'ceiling — an ideal selector, pays for both');
}

/** Three models, majority of correctness; pays for all three. */
export function replayVote3(matrix: ClusterMatrix, models: [string, string, string], singles: ModelSummary[]): Recipe | null {
  const items = commonItems(matrix, models);
  if (items.length < 2) return null;
  const q = items.map((i) => {
    const qs = models.map((m) => matrix.get(i)!.get(m)!.quality);
    const correct = qs.filter((x) => x >= 0.5).length;
    // majority on correctness; the quality credited is the median member's
    return correct >= 2 ? [...qs].sort((x, y) => x - y)[1]! : Math.min(...qs);
  });
  const c = items.map((i) => models.reduce((s, m) => s + matrix.get(i)!.get(m)!.costUsd, 0));
  return finish('vote3', models, q, c, singles, undefined, 'majority of three; exact on correctness');
}

/**
 * Two cheap models answer; if their correctness agrees the cheaper answer
 * stands, else the strong model decides. APPROXIMATE (see header).
 */
export function replayConsensusOrEscalate(
  matrix: ClusterMatrix,
  cheapA: string,
  cheapB: string,
  strong: string,
  singles: ModelSummary[],
  oracleQuality?: number,
): Recipe | null {
  const items = commonItems(matrix, [cheapA, cheapB, strong]);
  if (items.length < 2) return null;
  const q: number[] = [];
  const c: number[] = [];
  let escalations = 0;
  for (const i of items) {
    const row = matrix.get(i)!;
    const a = row.get(cheapA)!;
    const b = row.get(cheapB)!;
    const agree = (a.quality >= 0.5) === (b.quality >= 0.5);
    if (agree) {
      q.push(Math.max(a.quality, b.quality) >= 0.5 ? Math.max(a.quality, b.quality) : Math.min(a.quality, b.quality));
      c.push(a.costUsd + b.costUsd);
    } else {
      escalations++;
      const s = row.get(strong)!;
      q.push(s.quality);
      c.push(a.costUsd + b.costUsd + s.costUsd);
    }
  }
  return finish(
    'consensus-or-escalate',
    [cheapA, cheapB, strong],
    q,
    c,
    singles,
    { escalationRate: escalations / items.length },
    'approximate: agreement modelled as same-correctness (conservative)',
    oracleQuality,
  );
}

/**
 * Cheap model answers; escalate to the strong model when its confidence is
 * below τ. Exact replay from cached confidence; items where the cheap model
 * carried no confidence are treated as escalations (we cannot trust what we
 * cannot read). Sweeps τ and returns the best-dominating threshold.
 */
export function replayConfidenceGatedCascade(
  matrix: ClusterMatrix,
  cheap: string,
  strong: string,
  singles: ModelSummary[],
  oracleQuality?: number,
): Recipe | null {
  const items = commonItems(matrix, [cheap, strong]);
  if (items.length < 2) return null;
  const covered = items.filter((i) => matrix.get(i)!.get(cheap)!.confidence !== undefined).length;
  if (covered < Math.max(2, items.length * 0.5)) return null; // not enough signal to replay
  let best: Recipe | null = null;
  for (const tau of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    const q: number[] = [];
    const c: number[] = [];
    let esc = 0;
    for (const i of items) {
      const row = matrix.get(i)!;
      const a = row.get(cheap)!;
      const s = row.get(strong)!;
      const escalate = a.confidence === undefined || a.confidence < tau;
      if (escalate) {
        esc++;
        q.push(s.quality);
        c.push(a.costUsd + s.costUsd);
      } else {
        q.push(a.quality);
        c.push(a.costUsd);
      }
    }
    const r = finish('confidence-gated-cascade', [cheap, strong], q, c, singles, { tau, escalationRate: esc / items.length }, 'exact replay on cached confidence', oracleQuality);
    if (!best || (r.cheaperAndAsGood && !best.cheaperAndAsGood) || (r.cheaperAndAsGood === best.cheaperAndAsGood && r.meanQuality - best.meanQuality > 1e-9)) best = r;
  }
  return best;
}

export interface ClusterReplay {
  clusterId: string;
  singles: ModelSummary[];
  /** Ranked: dominating recipes first, then by quality delta, then cost saving. */
  recipes: Recipe[];
  /** Pairs whose oracle ceiling beats the best single (the raw headroom). */
  headroomPairs: Array<{ models: [string, string]; oracleQuality: number; headroom: number }>;
}

/**
 * Replay every mechanism over every eligible pair/triple. Bounded: at most
 * `maxModels` singles (by quality) enter the combinatorics, so a 23-model
 * cluster replays in well under a second.
 */
export function replayCluster(clusterId: string, matrix: ClusterMatrix, opts: { maxModels?: number; minItems?: number } = {}): ClusterReplay {
  const singles = summarizeModels(matrix).filter((s) => s.n >= (opts.minItems ?? 8));
  const pool = singles.slice(0, opts.maxModels ?? 12).map((s) => s.model);
  const recipes: Recipe[] = [];
  const headroomPairs: ClusterReplay['headroomPairs'] = [];
  const best = singles[0];
  if (!best || pool.length < 2) return { clusterId, singles, recipes, headroomPairs };

  const oracleOf = new Map<string, number>();
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i]!;
      const b = pool[j]!;
      const o = replayOracle(matrix, a, b, singles);
      if (!o) continue;
      oracleOf.set(`${a}|${b}`, o.meanQuality);
      recipes.push(o);
      if (o.meanQuality > best.meanQuality + 1e-9) {
        headroomPairs.push({ models: [a, b], oracleQuality: o.meanQuality, headroom: o.meanQuality - best.meanQuality });
      }
    }
  }
  // realizable recipes: cheap→strong orderings by cost. The escalation
  // target must be a genuinely strong model (within 2pts of the best single)
  // — escalating to a cheaper-but-weaker model is not a mixture, it is noise.
  const byCost = [...singles].filter((s) => pool.includes(s.model)).sort((x, y) => x.meanCostUsd - y.meanCostUsd).map((s) => s.model);
  const strongTier = new Set(singles.filter((s) => s.meanQuality >= best.meanQuality - 0.02).map((s) => s.model));
  for (let i = 0; i < byCost.length; i++) {
    for (let j = i + 1; j < byCost.length; j++) {
      const cheap = byCost[i]!;
      const strong = byCost[j]!;
      if (!strongTier.has(strong)) continue;
      const oq = oracleOf.get(`${cheap}|${strong}`) ?? oracleOf.get(`${strong}|${cheap}`);
      const g = replayConfidenceGatedCascade(matrix, cheap, strong, singles, oq);
      if (g) recipes.push(g);
      for (let k = i + 1; k < j; k++) {
        const r = replayConsensusOrEscalate(matrix, cheap, byCost[k]!, strong, singles, oq);
        if (r) recipes.push(r);
      }
    }
  }
  // votes over the cheapest triples (ensembles of expensive models never pay)
  const cheapest = byCost.slice(0, Math.min(5, byCost.length));
  for (let i = 0; i < cheapest.length; i++)
    for (let j = i + 1; j < cheapest.length; j++)
      for (let k = j + 1; k < cheapest.length; k++) {
        const v = replayVote3(matrix, [cheapest[i]!, cheapest[j]!, cheapest[k]!], singles);
        if (v) recipes.push(v);
      }

  recipes.sort(
    (a, b) =>
      Number(b.cheaperAndAsGood) - Number(a.cheaperAndAsGood) ||
      Number(b.frontierCandidate) - Number(a.frontierCandidate) ||
      b.qualityDeltaVsBestSingle - a.qualityDeltaVsBestSingle ||
      b.costSavingVsBestSingle - a.costSavingVsBestSingle,
  );
  headroomPairs.sort((a, b) => b.headroom - a.headroom);
  return { clusterId, singles, recipes, headroomPairs };
}

/** One line per cluster for the digest. */
export function replayDigestLine(r: ClusterReplay): string {
  const dom = r.recipes.filter((x) => x.cheaperAndAsGood && x.kind !== 'oracle');
  const top = r.headroomPairs[0];
  const head = top ? `headroom +${(top.headroom * 100).toFixed(1)}pts (${top.models.join(' + ')})` : 'no pair beats the best single';
  const real = dom[0]
    ? `realizable: ${dom[0].kind} ${dom[0].models.join('→')} q ${dom[0].meanQuality.toFixed(3)} at ${(dom[0].costSavingVsBestSingle * 100).toFixed(0)}% cheaper`
    : 'nothing realizable is cheaper-and-as-good yet';
  return `${r.clusterId}: ${head} · ${real}`;
}
