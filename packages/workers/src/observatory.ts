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

/** The UTC [start, end) of an ISO week id such as '2026-W37'. */
export function isoWeekRange(week: string): { from: Date; to: Date } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`not an ISO week id: ${week}`);
  const year = Number(m[1]);
  const wk = Number(m[2]);
  // ISO week 1 contains Jan 4; weeks start on Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  const from = new Date(week1Monday.getTime() + (wk - 1) * 7 * 86400000);
  return { from, to: new Date(from.getTime() + 7 * 86400000) };
}

export interface LedgerRow {
  /** ISO date-time of the run. */
  at: string;
  week: string;
  /**
   * 'budget-canary' added 2026-09-04: observatory-week.ts has been writing
   * that lane to the ledger, and the union never listed it. Nothing caught
   * it because scripts/ was outside `pnpm -r typecheck`. The rows are real
   * and already counted — envelopeFor sums spend across every lane — so the
   * type was the half that was wrong.
   */
  lane: 'canary' | 'audition' | 'budget-canary';
  /** Live spend the lane actually incurred. */
  spendUsd: number;
  detail?: string;
}

export const OBSERVATORY_ENVELOPE_USD = 50;
/**
 * Two numbers per lane, deliberately different (first live week, 2026-08-22):
 * the harness preflight refuses on a PESSIMISTIC projection (max answer +
 * judge tokens × judge price — a 4-item canary projected $0.19–$2.50), so the
 * per-run CAP is a ceiling the projection must clear, while planning and the
 * envelope work on EXPECTED actuals. Actual spend is ledgered after each run
 * and the ops org's hard-stop belt sits at the envelope remainder, so a run
 * that costs more than expected is caught by the money, not by a guess.
 */
export const CANARY_CAP_USD = 3;
export const CANARY_EXPECTED_USD = 0.2;
export const AUDITION_CAP_USD = 6;
export const AUDITION_EXPECTED_USD = 2;
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
  const canaryNeed = clusters.length * CANARY_EXPECTED_USD;
  let remaining = envelope.remainingUsd;
  let canaryClusters = clusters;
  if (remaining < canaryNeed) {
    const afford = Math.floor(remaining / CANARY_EXPECTED_USD);
    canaryClusters = clusters.slice(0, afford);
    notes.push(
      `envelope remainder $${remaining.toFixed(2)} affords ${afford}/${clusters.length} canaries — ` +
        `${clusters.slice(afford).join(', ') || 'none'} skipped this week`,
    );
  }
  const canaryBudgetUsd = canaryClusters.length * CANARY_EXPECTED_USD;
  remaining -= canaryBudgetUsd;
  const auditions = Math.min(AUDITIONS_PER_WEEK, Math.floor(remaining / AUDITION_EXPECTED_USD));
  if (auditions < AUDITIONS_PER_WEEK) {
    notes.push(`envelope remainder $${remaining.toFixed(2)} affords ${auditions}/${AUDITIONS_PER_WEEK} auditions`);
  }
  return { canaryClusters, canaryBudgetUsd, auditions, auditionBudgetUsd: auditions * AUDITION_EXPECTED_USD, notes };
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
// Saturation (A3, 2026-08-24)

export type SaturationLevel = 'saturated' | 'near' | 'ok';

export interface ClusterSaturation {
  clusterId: string;
  /** Best quality on the cluster's current frontier. */
  topQuality: number;
  /** Points within 0.02 of the top — a crowded top is the same disease. */
  crowdedTop: number;
  verdict: SaturationLevel;
}

/**
 * An instrument stops being an instrument the day the champion stops
 * failing: a suite where the best point sits at ~1.0 cannot rank the next
 * model, so its crown is a statement about the SUITE's ceiling, not the
 * model's (found live 2026-08-24: code-gen and classification both pinned
 * at 1.000 across salted runs). This reads stored frontiers only — $0 —
 * and alarms so hardening happens on schedule instead of on suspicion.
 * 'near' is the tripwire; 'saturated' means hardening is due now.
 */
export function saturationVerdict(points: FrontierPoint[]): Omit<ClusterSaturation, 'clusterId'> {
  if (points.length === 0) return { topQuality: Number.NaN, crowdedTop: 0, verdict: 'ok' };
  const top = points.reduce((m, p) => Math.max(m, p.quality), 0);
  const crowded = points.filter((p) => p.quality >= top - 0.02).length;
  const verdict: SaturationLevel =
    top >= 0.99 ? 'saturated' : top >= 0.97 && crowded >= 3 ? 'saturated' : top >= 0.97 ? 'near' : 'ok';
  return { topQuality: top, crowdedTop: crowded, verdict };
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

/** Lane 1b (2026-08-23): the same pick re-run under a customer-sized output
 * budget. 'budget-blind' = it lost more than half its stored quality there. */
export interface BudgetCanary {
  clusterId: string;
  model: string;
  strategyHash: string;
  storedQuality: number;
  observedMean: number | null;
  n: number;
  budgetTokens: number;
  verdict: 'ok' | 'budget-blind' | 'inconclusive';
  spendUsd: number;
  error?: string;
}

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
  budgetCanaries?: BudgetCanary[];
  auditions: AuditionResult[];
  /** New listings seen this week (before ranking) — the catalogue's pulse. */
  catalogue: { listings: number; newSinceRegistry: number; skippedNoPricing: number; freeTierExcluded: number; ranked: number };
  /** A3: instrument-saturation readings per cluster ($0, from stored frontiers). */
  saturation?: ClusterSaturation[];
  /** 2026-09-11: the week's learning proposals — the measurement record
   * Frontier Notes read now that auditions are retired. */
  proposals?: ProposalRecord[];
  spendUsd: number;
  envelopeAfter: Envelope;
}

/** A learning-period proposal as the run record carries it (redacted to
 * what a note may say: no org names, no prompts). */
export interface ProposalRecord {
  clusterId: string;
  incumbentModel: string;
  servingModel: string;
  incumbentQuality: number;
  servingQuality: number;
  suggestedFloor: number;
  projectedSaving: number | null;
  items: number;
  status: string;
  createdAt: string;
}

/**
 * The weekly run record, composed from the ledgers instead of written by
 * the retired weekly script (2026-09-11): canaries from drift_canaries,
 * proposals from learning_proposals, no auditions. Same shape, so Frontier
 * Notes and the Delta/Auditor harnesses read it unchanged.
 */
export function observatoryRunFromLedger(
  week: string,
  canaries: CanaryResult[],
  proposals: ProposalRecord[],
  at: Date = new Date(),
): ObservatoryRun {
  const spendUsd = canaries.reduce((s, c) => s + c.spendUsd, 0);
  const envelope: Envelope = {
    monthKey: at.toISOString().slice(0, 7),
    capUsd: OBSERVATORY_ENVELOPE_USD,
    mtdUsd: spendUsd,
    remainingUsd: Math.max(0, OBSERVATORY_ENVELOPE_USD - spendUsd),
  };
  return {
    week,
    at: at.toISOString(),
    envelopeBefore: envelope,
    plan: {
      canaryClusters: canaries.map((c) => c.clusterId),
      canaryBudgetUsd: canaries.length * CANARY_EXPECTED_USD,
      auditions: 0,
      auditionBudgetUsd: 0,
      notes: ['auditions retired 2026-09-11 — the proposal ledger is the measurement record; canaries are the drift tripwire'],
    },
    canaries,
    auditions: [],
    catalogue: { listings: 0, newSinceRegistry: 0, skippedNoPricing: 0, freeTierExcluded: 0, ranked: 0 },
    proposals,
    spendUsd,
    envelopeAfter: envelope,
  };
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
  const saturated = (run.saturation ?? []).filter((s) => s.verdict === 'saturated');
  if (saturated.length > 0) {
    parts.push(`INSTRUMENT SATURATED: ${saturated.map((s) => `${s.clusterId} (top ${s.topQuality.toFixed(3)})`).join(', ')} — hardening due`);
  }
  return parts.join(' · ');
}
