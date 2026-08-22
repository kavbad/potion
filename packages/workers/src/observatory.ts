// THE OBSERVATORY — pure logic for the weekly measurement run
// (docs/OBSERVATORY.md). Everything that decides WHAT to spend on and HOW to
// read a result lives here, testable without a database or a provider; the
// script that drives providers and the db is a thin caller.
//
// Governance, restated in code: one monthly envelope, canaries first (fixed,
// cheap), then auditions ranked by where a candidate could plausibly matter;
// every dollar ledgered; nulls published.
import type { FrontierPoint, PriceEntry } from '@potion/core';

// ---------------------------------------------------------------------------
// Time

/** ISO-8601 week id, e.g. '2026-W35' — the canary cache salt and run id. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Envelope

export interface LedgerRow {
  /** ISO date-time of the run. */
  at: string;
  week: string;
  lane: 'canary' | 'audition';
  /** Live spend the lane actually incurred. */
  spendUsd: number;
  detail?: string;
}

export const OBSERVATORY_ENVELOPE_USD = 50;
/** Canaries are fixed and first; this is the ceiling per cluster per week. */
export const CANARY_CAP_USD = 0.15;
/** One audition = one candidate on one cluster, full suite, under this cap. */
export const AUDITION_CAP_USD = 2;
/** Auditions per week — breadth at a manageable rate. */
export const AUDITIONS_PER_WEEK = 3;
/** Items per canary — enough to notice a collapse, cheap enough to run weekly. */
export const CANARY_SAMPLE_N = 4;

export interface Envelope {
  monthKey: string;
  capUsd: number;
  mtdUsd: number;
  remainingUsd: number;
}

export function envelopeFor(rows: LedgerRow[], now: Date, capUsd = OBSERVATORY_ENVELOPE_USD): Envelope {
  const monthKey = now.toISOString().slice(0, 7);
  const mtdUsd = rows
    .filter((r) => r.at.slice(0, 7) === monthKey)
    .reduce((s, r) => s + r.spendUsd, 0);
  return { monthKey, capUsd, mtdUsd, remainingUsd: Math.max(0, capUsd - mtdUsd) };
}

export interface LanePlan {
  /** Clusters that get a canary this week (all of them, or none if the belt is gone). */
  canaryClusters: string[];
  canaryBudgetUsd: number;
  /** How many auditions the remainder affords, capped at AUDITIONS_PER_WEEK. */
  auditions: number;
  auditionBudgetUsd: number;
  /** What was cut and why — published, never silent. */
  notes: string[];
}

/** Canaries first, then auditions, inside what is left of the envelope. */
export function planLanes(envelope: Envelope, clusters: string[]): LanePlan {
  const notes: string[] = [];
  const canaryNeed = clusters.length * CANARY_CAP_USD;
  let remaining = envelope.remainingUsd;
  let canaryClusters = clusters;
  if (remaining < canaryNeed) {
    const afford = Math.floor(remaining / CANARY_CAP_USD);
    canaryClusters = clusters.slice(0, afford);
    notes.push(
      `envelope remainder $${remaining.toFixed(2)} affords ${afford}/${clusters.length} canaries — ` +
        `${clusters.slice(afford).join(', ') || 'none'} skipped this week`,
    );
  }
  const canaryBudgetUsd = canaryClusters.length * CANARY_CAP_USD;
  remaining -= canaryBudgetUsd;
  const auditions = Math.min(AUDITIONS_PER_WEEK, Math.floor(remaining / AUDITION_CAP_USD));
  if (auditions < AUDITIONS_PER_WEEK) {
    notes.push(`envelope remainder $${remaining.toFixed(2)} affords ${auditions}/${AUDITIONS_PER_WEEK} auditions`);
  }
  return { canaryClusters, canaryBudgetUsd, auditions, auditionBudgetUsd: auditions * AUDITION_CAP_USD, notes };
}

// ---------------------------------------------------------------------------
// Canaries

/** Which point to canary: the routed pick under a sane floor, else the
 *  cheapest — the point a partner's traffic is most likely to be riding. */
export function canaryTarget(points: FrontierPoint[], floor = 0.85): FrontierPoint | null {
  if (points.length === 0) return null;
  const eligible = points.filter((p) => p.quality >= floor);
  const pool = eligible.length > 0 ? eligible : points;
  return pool.reduce((a, b) => (b.costPer1K < a.costPer1K ? b : a));
}

export type DriftVerdict = 'ok' | 'drift' | 'inconclusive';

/**
 * Statistical process control, the honest way: a 4-item canary is a noisy
 * instrument, so it only ALARMS when the observed mean falls outside the
 * stored interval widened by the canary's own binomial noise. Outside on the
 * high side is not drift (a model got better is a republish question, not an
 * alarm). Fewer than 2 scored items cannot say anything.
 */
export function driftVerdict(
  stored: { quality: number; qualityCi95: number },
  observed: { meanQuality: number; n: number },
): { verdict: DriftVerdict; lowerBound: number } {
  if (observed.n < 2) return { verdict: 'inconclusive', lowerBound: Number.NaN };
  const p = Math.min(0.999, Math.max(0.001, stored.quality));
  const canaryNoise = 1.96 * Math.sqrt((p * (1 - p)) / observed.n);
  const lowerBound = stored.quality - stored.qualityCi95 - canaryNoise;
  return { verdict: observed.meanQuality < lowerBound ? 'drift' : 'ok', lowerBound };
}

// ---------------------------------------------------------------------------
// Auditions — v1 ranking (S7's demand ranking replaces this when it lands)

/** Specialist lanes (OBSERVATORY.md §3): a name pattern → the clusters it
 *  could move. Generalist catalogues under-list these; we scout for them. */
export const SPECIALIST_LANES: ReadonlyArray<{ lane: string; pattern: RegExp; clusters: string[] }> = [
  { lane: 'code-tuned', pattern: /cod(e|er)|dev|program/i, clusters: ['code-gen', 'code-review'] },
  { lane: 'extraction/json', pattern: /json|extract|struct|parse/i, clusters: ['extraction'] },
  { lane: 'function-calling', pattern: /tool|function|agent/i, clusters: ['agentic-tool-use'] },
  { lane: 'math/reasoning', pattern: /math|reason|think|r1\b|o[1-9]\b/i, clusters: ['multi-step-reasoning'] },
  { lane: 'multilingual', pattern: /multi|lingual|translat|ling\b/i, clusters: ['rewrite-edit', 'summarization'] },
  { lane: 'small/cheap', pattern: /mini|small|flash|lite|nano|tiny|\b\d{1,2}b\b/i, clusters: ['classification', 'rag-answer', 'summarization'] },
];

export interface RankedCandidate {
  entry: PriceEntry;
  /** The single cluster this audition plays (auditions are one-cluster by design). */
  clusterId: string;
  lane: string;
  /** Higher = more worth a $2 look. */
  score: number;
  why: string;
}

/** Blended price per 1M tokens at a 3:1 input:output mix — the ordering key. */
export function blendedPer1M(e: PriceEntry): number {
  return (3 * e.inputPer1M + e.outputPer1M) / 4;
}

/**
 * v1 ranking: cheap-and-specialist first. A candidate earns a look on the
 * cluster its name suggests; generic names audition on the cluster where the
 * current routed pick is most expensive (the biggest prize if it wins).
 * Routers, batch endpoints, and unpriced listings never reach here (the
 * catalogue parser refuses them upstream).
 */
/** A free-tier endpoint can never be a SERVING candidate: no SLA, rate
 *  limits, and often trained on inputs. Auditioning one could earn it a
 *  frontier slot a partner's traffic would then ride. Excluded, and the
 *  exclusion is published. */
export function isFreeTier(e: PriceEntry): boolean {
  return /(^|[-:])free$/i.test(e.alias) || /:free$/i.test(e.model) || (e.inputPer1M === 0 && e.outputPer1M === 0);
}

export function rankCandidates(
  added: PriceEntry[],
  routedCostPer1KByCluster: Record<string, number>,
  limit = AUDITIONS_PER_WEEK,
): RankedCandidate[] {
  const priciestCluster = Object.entries(routedCostPer1KByCluster).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'code-gen';
  const ranked: RankedCandidate[] = [];
  for (const entry of added.filter((e) => !isFreeTier(e))) {
    const name = `${entry.alias} ${entry.model}`;
    const lane = SPECIALIST_LANES.find((l) => l.pattern.test(name));
    const clusterId = lane?.clusters[0] ?? priciestCluster;
    const price = blendedPer1M(entry);
    // cheaper → higher; specialist match → bonus; avoid log(0)
    const score = (lane ? 2 : 0) + 1 / Math.log10(10 + Math.max(0, price));
    ranked.push({
      entry,
      clusterId,
      lane: lane?.lane ?? 'generalist',
      score,
      why: lane
        ? `${lane.lane} by name → ${clusterId}; $${price.toFixed(2)}/1M blended`
        : `generalist → ${clusterId} (priciest routed pick); $${price.toFixed(2)}/1M blended`,
    });
  }
  return ranked.sort((a, b) => b.score - a.score || a.entry.alias.localeCompare(b.entry.alias)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// The run record — nulls are published

export interface CanaryResult {
  clusterId: string;
  model: string;
  strategyHash: string;
  storedQuality: number;
  storedCi95: number;
  observedMean: number | null;
  n: number;
  verdict: DriftVerdict;
  spendUsd: number;
  error?: string;
}

export interface AuditionResult {
  alias: string;
  clusterId: string;
  lane: string;
  why: string;
  spendUsd: number;
  /** Did the candidate land on the new frontier for that cluster? */
  earnedSlot: boolean | null;
  frontierVersion: number | null;
  error?: string;
}

export interface ObservatoryRun {
  week: string;
  at: string;
  envelopeBefore: Envelope;
  plan: LanePlan;
  canaries: CanaryResult[];
  auditions: AuditionResult[];
  /** New listings seen this week (before ranking) — the catalogue's pulse. */
  catalogue: { listings: number; newSinceRegistry: number; skippedNoPricing: number; freeTierExcluded: number; ranked: number };
  spendUsd: number;
  envelopeAfter: Envelope;
}

/** The one line a human reads. Quiet weeks say so. */
export function digestLine(run: ObservatoryRun): string {
  const drift = run.canaries.filter((c) => c.verdict === 'drift');
  const inconclusive = run.canaries.filter((c) => c.verdict === 'inconclusive').length;
  const earned = run.auditions.filter((a) => a.earnedSlot === true);
  const failed = run.auditions.filter((a) => a.error).length;
  const parts = [
    `${run.week}: ${run.canaries.length} canaries — ${drift.length === 0 ? 'no drift' : `DRIFT on ${drift.map((d) => `${d.clusterId}/${d.model}`).join(', ')}`}` +
      (inconclusive > 0 ? ` (${inconclusive} inconclusive)` : ''),
    run.auditions.length === 0
      ? `no auditions (${run.catalogue.newSinceRegistry} new listings, ${run.catalogue.freeTierExcluded} free-tier excluded, ${run.catalogue.ranked} ranked)`
      : `${run.auditions.length} auditioned — ${earned.length === 0 ? 'none earned a slot' : `EARNED: ${earned.map((a) => `${a.alias} on ${a.clusterId}`).join(', ')}`}` +
        (failed > 0 ? ` (${failed} errored)` : ''),
    `spend $${run.spendUsd.toFixed(2)}; month $${run.envelopeAfter.mtdUsd.toFixed(2)} of $${run.envelopeAfter.capUsd}`,
  ];
  return parts.join(' · ');
}
