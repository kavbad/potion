// ATLAS — THE AGENDA (F8, operator-directed 2026-09-04: "automate thinking
// through what to write and post to make Potion Research the Bloomberg for
// inference economics").
//
// THE FAILURE THIS REPLACES: the daily lane published what the instruments
// DID ("three cycles ran and found nothing new") — internal ops telemetry
// that is true, verified, and worthless. Nobody searches for it. Meanwhile
// the corpus held, unpublished: on code generation a perfect scorer costs
// $6.85 per thousand requests and a model 2.1 points behind costs $0.023 —
// a 297× premium for the last two points. That is the story, and it was
// sitting in a database table.
//
// The correction: the daily unit is not "what we did today", it is "what
// our measurements can prove that somebody is trying to find out today".
// This module turns the corpus into a RANKED AGENDA of such pieces, so the
// question "what should we publish?" is answered by evidence and demand
// rather than by whatever the instruments happened to log.
//
// The scoring is deterministic and inspectable ON PURPOSE: an editorial
// judgment nobody can audit is how a research brand dies. A model-driven
// Atlas can add judgment ON TOP of this candidate space later — but the
// space itself, and the reasons, must be checkable by a human first.

/** One measured point on a cluster's economic frontier. */
export interface AgendaPoint {
  model: string;
  quality: number;
  costPer1K: number;
  n: number;
}

export interface ClusterSignal {
  clusterId: string;
  /** The public question this cluster answers (the AEO surface). */
  question?: string;
  points: AgendaPoint[];
  measuredAt?: string;
}

export type CandidateKind =
  | 'quality-premium'
  | 'cheapest-at-floor'
  | 'head-to-head'
  | 'price-outlier'
  | 'category-explainer';

export interface AgendaCandidate {
  /** Stable across days: the novelty check dedupes on it. */
  id: string;
  kind: CandidateKind;
  clusterId: string;
  /** The empirical claim, magnitude first (RESEARCH-WRITING §6). */
  headline: string;
  /** What the piece can prove, in one line — the dek's raw material. */
  dek: string;
  /** The question a reader types or asks. This is the AEO/SEO target and
   * the reason the piece exists. */
  demandQuery: string;
  /** Every number the writer may use — nothing else is available to it. */
  evidence: Record<string, number | string>;
  scores: { demand: number; magnitude: number; evidence: number; novelty: number };
  score: number;
  /** Why this ranks here, in words a human can argue with. */
  why: string;
}

/** Demand priors: how much of the market is asking about this kind of work.
 * Deliberately explicit and editable — this is a judgment, and a judgment
 * that hides inside a formula is a judgment nobody can challenge. */
const CLUSTER_DEMAND: Record<string, number> = {
  'code-gen': 1.0,
  'agentic-tool-use': 0.95,
  classification: 0.85,
  extraction: 0.85,
  'rag-answer': 0.8,
  'code-review': 0.75,
  summarization: 0.7,
  'multi-step-reasoning': 0.7,
  'rewrite-edit': 0.55,
  creative: 0.5,
};

/** Kind priors: how reliably this shape of piece earns its readership. */
const KIND_DEMAND: Record<CandidateKind, number> = {
  'quality-premium': 1.0,
  'cheapest-at-floor': 0.95,
  'head-to-head': 0.9,
  'price-outlier': 0.7,
  'category-explainer': 0.6,
};

const money = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`);
const q3 = (x: number) => x.toFixed(3);
const ratio = (x: number) => (x >= 100 ? `${Math.round(x)}×` : x >= 10 ? `${x.toFixed(0)}×` : `${x.toFixed(1)}×`);

/** Magnitude on a log scale: a 300× premium is a story, 1.4× is a footnote. */
function magnitudeScore(x: number): number {
  if (!Number.isFinite(x) || x <= 1) return 0;
  return Math.min(1, Math.log10(x) / 2.5); // 1× → 0, 316× → ~1
}

/** Evidence strength from sample size — the interval discipline in one number. */
function evidenceScore(n: number): number {
  if (n <= 0) return 0;
  return Math.min(1, Math.log10(n + 1) / 2); // n=10 → 0.52, n=100 → 1
}

/** Days-since-publication, saturating at 60 — 1 when never told. */
function decay(key: string, published: ReadonlyMap<string, string>, now: Date): number {
  const last = published.get(key);
  if (last === undefined) return 1;
  const days = (now.getTime() - Date.parse(last)) / 86_400_000;
  if (!Number.isFinite(days)) return 1;
  return Math.max(0, Math.min(1, days / 60));
}

/** The CLAIM a candidate rests on: a cluster and the models compared. Two
 * pieces with the same claim are the same story from different angles. */
export function claimKey(clusterId: string, evidence: Record<string, number | string>): string {
  const models = Object.entries(evidence)
    .filter(([k, v]) => typeof v === 'string' && /model/i.test(k))
    .map(([, v]) => String(v))
    .sort()
    .join('|');
  return `claim:${clusterId}:${models}`;
}

/** Novelty: decayed by BOTH the piece and the claim beneath it. Telling the
 * code-gen 296× story yesterday must also cool "the cheapest model that
 * clears 0.9 on code-gen" today — same two models, same story, new hat.
 * Rotating angles on one claim is how a research brand starts to read like
 * a content farm. */
function noveltyScore(id: string, claim: string, published: ReadonlyMap<string, string>, now: Date): number {
  return Math.min(decay(id, published, now), decay(claim, published, now));
}

export interface AgendaInput {
  signals: readonly ClusterSignal[];
  /** id AND claim keys → ISO date last published. */
  published?: ReadonlyMap<string, string>;
  now: Date;
  /** Quality floors the market actually buys at. */
  floors?: readonly number[];
  /** THE COOLDOWN (days): a claim told inside this window is EXCLUDED, not
   * merely down-ranked. Down-weighting is for ranking; repetition avoidance
   * has to be a filter, because a genuinely huge story (296× on the highest
   * demand cluster) out-scores every alternative the day after it ran — so
   * a weight alone reruns yesterday's piece forever. Default 21 days. */
  cooldownDays?: number;
}

/**
 * THE AGENDA: every piece the corpus can prove today, ranked.
 *
 * Each generator answers a question somebody is already asking, and every
 * candidate carries the exact numbers that prove it — a writer downstream
 * may use those and nothing else.
 */
export function generateAgenda(input: AgendaInput): AgendaCandidate[] {
  const published = input.published ?? new Map<string, string>();
  const floors = input.floors ?? [0.9, 0.95, 0.99];
  const out: AgendaCandidate[] = [];

  const push = (
    c: Omit<AgendaCandidate, 'scores' | 'score' | 'why'>,
    parts: { demand: number; magnitude: number; evidence: number },
  ) => {
    const novelty = noveltyScore(c.id, claimKey(c.clusterId, c.evidence), published, input.now);
    const scores = { ...parts, novelty };
    // Demand and evidence gate; magnitude and novelty rank. A huge number
    // nobody asked about is trivia; a popular question we cannot prove is
    // an opinion. Both must be present.
    const score = Number((scores.demand * 0.3 + scores.magnitude * 0.35 + scores.evidence * 0.15 + scores.novelty * 0.2).toFixed(4));
    out.push({
      ...c,
      scores,
      score,
      why:
        `demand ${scores.demand.toFixed(2)} (${c.kind} on ${c.clusterId}), magnitude ${scores.magnitude.toFixed(2)}, ` +
        `evidence ${scores.evidence.toFixed(2)}, novelty ${scores.novelty.toFixed(2)}`,
    });
  };

  for (const s of input.signals) {
    const pts = [...s.points].filter((p) => Number.isFinite(p.quality) && Number.isFinite(p.costPer1K) && p.costPer1K > 0);
    if (pts.length < 2) continue;
    const demandBase = CLUSTER_DEMAND[s.clusterId] ?? 0.5;
    const byQuality = [...pts].sort((a, b) => b.quality - a.quality);
    const top = byQuality[0]!;
    const nMin = Math.min(...pts.map((p) => p.n || 0));

    // ── 1. THE QUALITY PREMIUM — the category's defining question:
    //      what do the last points of quality actually cost?
    const cheaperAndClose = byQuality
      .slice(1)
      .filter((p) => p.costPer1K < top.costPer1K)
      .sort((a, b) => a.costPer1K - b.costPer1K)[0];
    if (cheaperAndClose) {
      const factor = top.costPer1K / cheaperAndClose.costPer1K;
      const points = (top.quality - cheaperAndClose.quality) * 100;
      if (factor > 1.5) {
        push({
          id: `quality-premium:${s.clusterId}`,
          kind: 'quality-premium',
          clusterId: s.clusterId,
          headline: `The last ${points.toFixed(1)} points of ${s.clusterId.replace(/-/g, ' ')} quality cost ${ratio(factor)}`,
          dek: `On Potion's measured ${s.clusterId} suite, one model scored ${q3(top.quality)} at ${money(top.costPer1K)} per thousand requests while another scored ${q3(cheaperAndClose.quality)} at ${money(cheaperAndClose.costPer1K)}.`,
          demandQuery: `how much does the best ${s.clusterId.replace(/-/g, ' ')} model cost vs a cheaper one`,
          evidence: {
            topModel: top.model,
            topQuality: top.quality,
            topCostPer1K: top.costPer1K,
            cheapModel: cheaperAndClose.model,
            cheapQuality: cheaperAndClose.quality,
            cheapCostPer1K: cheaperAndClose.costPer1K,
            factor: Number(factor.toFixed(1)),
            qualityPoints: Number(points.toFixed(1)),
            n: Math.min(top.n, cheaperAndClose.n),
          },
        }, {
          demand: Math.min(1, demandBase * KIND_DEMAND['quality-premium']),
          magnitude: magnitudeScore(factor),
          evidence: evidenceScore(Math.min(top.n, cheaperAndClose.n)),
        });
      }
    }

    // ── 2. CHEAPEST AT A FLOOR — the evergreen answer engines quote.
    // Floors whose CLEARING SET is identical are the same piece written
    // twice: publishing both is thin duplicate content, which is the
    // fastest way to lose the category we are trying to own. Keep the
    // strongest (highest) floor of each identical set.
    const seenClearingSets = new Set<string>();
    for (const floor of [...floors].sort((a, b) => b - a)) {
      const clearing = pts.filter((p) => p.quality >= floor).sort((a, b) => a.costPer1K - b.costPer1K);
      const cheapest = clearing[0];
      if (!cheapest || clearing.length < 2) continue;
      const setKey = clearing.map((p) => p.model).join('|');
      if (seenClearingSets.has(setKey)) continue;
      seenClearingSets.add(setKey);
      const dearest = clearing[clearing.length - 1]!;
      const factor = dearest.costPer1K / cheapest.costPer1K;
      if (factor <= 1.5) continue;
      push({
        id: `cheapest-at-floor:${s.clusterId}:${floor}`,
        kind: 'cheapest-at-floor',
        clusterId: s.clusterId,
        headline: `The cheapest model that clears ${floor} on ${s.clusterId.replace(/-/g, ' ')} costs ${ratio(factor)} less than the dearest that does`,
        dek: `${clearing.length} measured options clear ${floor} quality on ${s.clusterId}; they range from ${money(cheapest.costPer1K)} to ${money(dearest.costPer1K)} per thousand requests.`,
        demandQuery: `what is the cheapest model for ${s.clusterId.replace(/-/g, ' ')} at ${floor} quality`,
        evidence: {
          floor,
          clearingCount: clearing.length,
          cheapestModel: cheapest.model,
          cheapestCostPer1K: cheapest.costPer1K,
          cheapestQuality: cheapest.quality,
          dearestModel: dearest.model,
          dearestCostPer1K: dearest.costPer1K,
          factor: Number(factor.toFixed(1)),
          n: cheapest.n,
        },
      }, {
        demand: Math.min(1, demandBase * KIND_DEMAND['cheapest-at-floor']),
        magnitude: magnitudeScore(factor),
        evidence: evidenceScore(cheapest.n),
      });
    }

    // ── 3. HEAD TO HEAD — the comparison people type by name.
    const named = byQuality.filter((p) => !/^[0-9a-f]{8}$/.test(p.model)).slice(0, 3);
    if (named.length >= 2) {
      const [a, b] = [named[0]!, named[1]!];
      const factor = Math.max(a.costPer1K, b.costPer1K) / Math.min(a.costPer1K, b.costPer1K);
      if (factor > 2) {
        push({
          id: `head-to-head:${s.clusterId}:${[a.model, b.model].sort().join('|')}`,
          kind: 'head-to-head',
          clusterId: s.clusterId,
          headline: `${a.model} vs ${b.model} on ${s.clusterId.replace(/-/g, ' ')}: ${((a.quality - b.quality) * 100).toFixed(1)} quality points, ${ratio(factor)} price`,
          dek: `Both measured on the same held-out ${s.clusterId} suite: ${a.model} at ${q3(a.quality)} and ${money(a.costPer1K)}, ${b.model} at ${q3(b.quality)} and ${money(b.costPer1K)} per thousand requests.`,
          demandQuery: `${a.model} vs ${b.model} for ${s.clusterId.replace(/-/g, ' ')}`,
          evidence: {
            modelA: a.model,
            qualityA: a.quality,
            costA: a.costPer1K,
            modelB: b.model,
            qualityB: b.quality,
            costB: b.costPer1K,
            factor: Number(factor.toFixed(1)),
            n: Math.min(a.n, b.n),
          },
        }, {
          demand: Math.min(1, demandBase * KIND_DEMAND['head-to-head']),
          magnitude: magnitudeScore(factor),
          evidence: evidenceScore(Math.min(a.n, b.n)),
        });
      }
    }

    // ── 4. PRICE OUTLIER — a model whose price is not explained by its
    //      measured quality. The "overbought inference" story, per workload.
    const cheapest = [...pts].sort((x, y) => x.costPer1K - y.costPer1K)[0]!;
    const overpriced = pts
      .filter((p) => p.model !== cheapest.model && p.quality <= cheapest.quality && p.costPer1K > cheapest.costPer1K * 2)
      .sort((x, y) => y.costPer1K - x.costPer1K)[0];
    if (overpriced) {
      const factor = overpriced.costPer1K / cheapest.costPer1K;
      push({
        id: `price-outlier:${s.clusterId}:${overpriced.model}`,
        kind: 'price-outlier',
        clusterId: s.clusterId,
        headline: `${overpriced.model} costs ${ratio(factor)} more than a model that scores at least as well on ${s.clusterId.replace(/-/g, ' ')}`,
        dek: `Measured on the same suite: ${overpriced.model} at ${q3(overpriced.quality)} and ${money(overpriced.costPer1K)}, against ${cheapest.model} at ${q3(cheapest.quality)} and ${money(cheapest.costPer1K)}.`,
        demandQuery: `is ${overpriced.model} worth the price for ${s.clusterId.replace(/-/g, ' ')}`,
        evidence: {
          model: overpriced.model,
          quality: overpriced.quality,
          costPer1K: overpriced.costPer1K,
          rivalModel: cheapest.model,
          rivalQuality: cheapest.quality,
          rivalCostPer1K: cheapest.costPer1K,
          factor: Number(factor.toFixed(1)),
          n: Math.min(overpriced.n, cheapest.n),
        },
      }, {
        demand: Math.min(1, demandBase * KIND_DEMAND['price-outlier']),
        magnitude: magnitudeScore(factor),
        evidence: evidenceScore(Math.min(overpriced.n, cheapest.n)),
      });
    }
  }

  // THE COOLDOWN: drop anything whose piece or claim was told inside the
  // window. This is what makes a daily cadence rotate instead of hammering
  // its best number.
  const cooldownDays = input.cooldownDays ?? 21;
  const cooled = out.filter((c) => {
    const ageOf = (key: string): number => {
      const last = published.get(key);
      if (last === undefined) return Number.POSITIVE_INFINITY;
      const days = (input.now.getTime() - Date.parse(last)) / 86_400_000;
      return Number.isFinite(days) ? days : Number.POSITIVE_INFINITY;
    };
    return Math.min(ageOf(c.id), ageOf(claimKey(c.clusterId, c.evidence))) >= cooldownDays;
  });

  // THE DIVERSITY PASS: two candidates that rest on the SAME pair of models
  // in the same cluster are one story told twice — the agenda keeps the
  // stronger and drops the echo. A queue of near-identical pieces reads as
  // content farming, which is the opposite of owning a category.
  const ranked = cooled.sort((a, b) => b.score - a.score);
  const claimed = new Set<string>();
  const deduped: AgendaCandidate[] = [];
  for (const c of ranked) {
    const claim = claimKey(c.clusterId, c.evidence);
    if (claim.endsWith(':')) {
      deduped.push(c);
      continue;
    }
    if (claimed.has(claim)) continue;
    claimed.add(claim);
    deduped.push(c);
  }
  return deduped;
}

/** The agenda as an operator reads it: the queue, with the reasoning shown. */
export function renderAgenda(candidates: readonly AgendaCandidate[], limit = 12): string {
  const lines = [`THE AGENDA — ${candidates.length} publishable pieces the corpus can prove`, ''];
  for (const [i, c] of candidates.slice(0, limit).entries()) {
    lines.push(`${String(i + 1).padStart(2)}. [${c.score.toFixed(3)}] ${c.headline}`);
    lines.push(`    ${c.dek}`);
    lines.push(`    asks: "${c.demandQuery}"`);
    lines.push(`    ${c.why}`);
    lines.push('');
  }
  return lines.join('\n');
}
