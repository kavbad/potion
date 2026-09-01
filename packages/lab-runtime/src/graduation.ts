// L-G1 — the graduation evaluator (Lab direction v2, 2026-08-26).
//
// Graduation is RISK-AWARE, never a success-rate threshold: the decision is
// a function of capability evidence × action risk × uncertainty ×
// reversibility. The evaluator is a pure function so every verdict is
// reproducible from its inputs, and its asymmetry is the product:
//
//   TIGHTEN  — automatic. Drift, a rejection burst, or any reversal
//              re-supervises the class immediately. Fail closed.
//   LOOSEN   — proposal only. The evaluator can at most PROPOSE graduation;
//              a human accepts it (the bar-proposal pattern). Nothing in
//              this module grants autonomy.
//   NEVER    — the 'never-graduates' tier refuses permanently, regardless
//              of the record. That refusal is a feature; a success rate is
//              not an argument against it.
//
// Consequence outweighs volume: one unresolved high-stakes failure vetoes a
// thousand routine successes (999 correct refunds and one wrong $100,000
// refund is 99.9% and unacceptable — the named test pins that sentence).
//
// Uncertainty uses the platform's boundary-honest interval (jeffreysCi): a
// perfect 25/25 is a ≥-bound wide enough to matter, and the per-tier floors
// are compared against the interval's LOWER bound, never the mean.
import { jeffreysCi } from '@potion/core';

export type RiskTier = 'reversible-read' | 'reversible-act' | 'irreversible-act' | 'never-graduates';
export type GrantState = 'supervised' | 'autonomous' | 'blocked';

/** One observed action, reduced to the evaluator's vocabulary. Sources are
 * the composite signal set (pore answers, validators, outcomes, reversals,
 * sampled audit); extraction from run records is L-G2's job. */
export interface ActionEvidence {
  at: Date;
  /**
   * approved   — human approved the action as proposed
   * validated  — a deterministic validator or audited outcome confirmed it
   * edited     — human had to change it before it could run (a failure
   *              label, and the most informative one)
   * rejected   — human refused it
   * reversed   — the action ran and was later undone/complained about
   *              (a failure discovered downstream — the worst kind)
   */
  /** W2 adds 'exec-failed': an autonomous (gate-allowed) execution that
   * errored — machine-observed failure, uncapped like every failure. */
  outcome: 'approved' | 'validated' | 'edited' | 'rejected' | 'reversed' | 'exec-failed';
  /** Consequence flag from the action's context (value bands, entity
   * importance). High-stakes failures veto; high-stakes successes do not
   * buy extra credit. */
  highStakes: boolean;
  /** True when this record came from mandatory sampling of an already-
   * autonomous class — the label stream that never degrades with trust. */
  fromAudit?: boolean;
  /**
   * Input-situation identity (the Step-12 fingerprint / argsHash): WHICH
   * version of this action was observed. Diversity of situations is an
   * evidence dimension — 25 approvals of the same identical call are not 25
   * independent proofs (direction v3). Missing values collapse into one
   * shared bucket, which is the conservative reading: unattributed evidence
   * cannot claim to span the distribution.
   */
  situation?: string;
  /** W2 — the coarser param-shape signature (gateway.situationSignature):
   * the region vocabulary for distribution membership, distinct from the
   * per-call fingerprint above. */
  situationSignature?: string;
}

export interface GraduationInput {
  tier: RiskTier;
  state: GrantState;
  evidence: ActionEvidence[];
  now: Date;
}

export type GraduationDecision =
  | { kind: 'never'; why: string }
  | { kind: 'hold'; why: string }
  | { kind: 'tighten'; why: string }
  | { kind: 'propose-graduate'; why: string; evidence: EvidenceSummary };

export interface EvidenceSummary {
  n: number;
  successes: number;
  successLower95: number;
  windowDays: number;
  highStakesFailures: number;
  /** Distinct input situations the evidence spans (see REPEAT_EVIDENCE_CAP). */
  distinctSituations: number;
  /** Observations that actually counted toward the earning interval after
   * the per-situation repeat cap. */
  effectiveN: number;
}

/** Per-tier requirements — the risk-awareness, as data. minN and the floor
 * apply to the interval LOWER bound over the evidence window. */
export const TIER_RULES: Readonly<
  Record<Exclude<RiskTier, 'never-graduates'>, { minN: number; lowerFloor: number; windowDays: number }>
> = {
  'reversible-read': { minN: 25, lowerFloor: 0.9, windowDays: 90 },
  'reversible-act': { minN: 80, lowerFloor: 0.95, windowDays: 60 },
  'irreversible-act': { minN: 250, lowerFloor: 0.985, windowDays: 45 },
};

/** Autonomous classes are ALWAYS sampled — unaudited autonomy is unmeasured
 * autonomy. The floor is permanent; nothing lowers it to 0. */
export const AUDIT_RATE_FLOOR = 0.05;

/**
 * Diversity prior (direction v3): toward EARNING autonomy, at most this many
 * successful observations of the SAME input situation count as evidence.
 * Repeats beyond it are real work but not new proof — "25 nearly identical
 * successful actions may prove very little". A prior, not a magic number:
 * the binding requirement stays the interval lower bound over the effective
 * evidence. Failures are NEVER capped — every failure is signal — and the
 * autonomous drift re-check runs on RAW evidence: the cap governs what can
 * buy trust, never what can revoke it.
 */
export const REPEAT_EVIDENCE_CAP = 5;

/** The earning-side view of an evidence window: all failures, successes
 * capped per situation at REPEAT_EVIDENCE_CAP. */
export function effectiveEvidence(evidence: ActionEvidence[]): {
  scores: number[];
  rawN: number;
  effectiveN: number;
  distinctSituations: number;
} {
  const successPerSituation = new Map<string, number>();
  const situations = new Set<string>();
  const scores: number[] = [];
  for (const e of evidence) {
    const sit = e.situation ?? 'unfingerprinted';
    situations.add(sit);
    if (isFailure(e)) {
      scores.push(0);
      continue;
    }
    const seen = successPerSituation.get(sit) ?? 0;
    if (seen < REPEAT_EVIDENCE_CAP) {
      successPerSituation.set(sit, seen + 1);
      scores.push(1);
    }
  }
  return { scores, rawN: evidence.length, effectiveN: scores.length, distinctSituations: situations.size };
}

/** Recent-window trigger for automatic re-tightening: any reversal, or ≥2
 * rejections/edits within the recency window. */
const TIGHTEN_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

function isFailure(e: ActionEvidence): boolean {
  return e.outcome === 'rejected' || e.outcome === 'edited' || e.outcome === 'reversed' || e.outcome === 'exec-failed';
}

export function graduationDecision(input: GraduationInput): GraduationDecision {
  const { tier, state, evidence, now } = input;

  if (tier === 'never-graduates') {
    return {
      kind: 'never',
      why: 'this action class never graduates by design — no record argues with the tier',
    };
  }

  const rules = TIER_RULES[tier];
  const inWindow = evidence.filter((e) => now.getTime() - e.at.getTime() <= rules.windowDays * DAY_MS);
  const recent = evidence.filter((e) => now.getTime() - e.at.getTime() <= TIGHTEN_WINDOW_DAYS * DAY_MS);

  // ---- automatic tightening first: fail closed beats everything else ----
  const reversals = inWindow.filter((e) => e.outcome === 'reversed');
  const recentFailures = recent.filter(isFailure);
  if (state === 'autonomous') {
    if (reversals.length > 0) {
      return {
        kind: 'tighten',
        why: `${reversals.length} reversed action(s) in the ${rules.windowDays}d window — autonomy re-supervised immediately`,
      };
    }
    if (recentFailures.length >= 2) {
      return {
        kind: 'tighten',
        why: `${recentFailures.length} failures inside ${TIGHTEN_WINDOW_DAYS}d — drift; autonomy re-supervised`,
      };
    }
  }

  // ---- the high-stakes veto: consequence outweighs volume ----
  const highStakesFailures = inWindow.filter((e) => isFailure(e) && e.highStakes);
  if (highStakesFailures.length > 0) {
    if (state === 'autonomous') {
      return {
        kind: 'tighten',
        why: `${highStakesFailures.length} high-stakes failure(s) in window — vetoes the record regardless of rate`,
      };
    }
    return {
      kind: 'hold',
      why: `${highStakesFailures.length} unresolved high-stakes failure(s) — no volume of routine successes outweighs them`,
    };
  }

  // ---- capability evidence under boundary-honest uncertainty ----
  if (state === 'autonomous') {
    // Standing re-evaluation on RAW evidence: the drift check's job is to
    // catch problems, and every raw observation is signal — the diversity
    // cap governs earning, never revocation.
    const rawScores: number[] = inWindow.map((e) => (isFailure(e) ? 0 : 1));
    const [rawLower] = jeffreysCi(rawScores);
    if (inWindow.length > 0 && rawLower < rules.lowerFloor) {
      return {
        kind: 'tighten',
        why: `validated lower bound ${rawLower.toFixed(3)} fell below the ${tier} floor ${rules.lowerFloor}`,
      };
    }
    return { kind: 'hold', why: 'autonomous and holding its floor — standing sampled audit continues' };
  }

  // Earning runs on EFFECTIVE evidence (direction v3): repeats of the same
  // situation stop accumulating trust past the cap, so a narrow distribution
  // cannot buy autonomy on volume alone.
  const eff = effectiveEvidence(inWindow);
  const successes = eff.scores.reduce((s, x) => s + x, 0);
  const [lower] = jeffreysCi(eff.scores);

  if (eff.effectiveN < rules.minN) {
    const narrowed = eff.rawN > eff.effectiveN
      ? ` (${eff.rawN} observed across ${eff.distinctSituations} distinct situation(s) — repeats past ${REPEAT_EVIDENCE_CAP} per situation don't accumulate trust)`
      : '';
    return {
      kind: 'hold',
      why: `${eff.effectiveN} of ${rules.minN} effective observations required for ${tier}${narrowed} — keep supervising`,
    };
  }
  if (lower < rules.lowerFloor) {
    return {
      kind: 'hold',
      why: `lower bound ${lower.toFixed(3)} below the ${tier} floor ${rules.lowerFloor} (effective n=${eff.effectiveN} across ${eff.distinctSituations} situations) — evidence, not enough of it`,
    };
  }

  // ---- loosening is only ever a PROPOSAL — nothing here grants ----
  return {
    kind: 'propose-graduate',
    why:
      `${eff.effectiveN} effective observations across ${eff.distinctSituations} distinct situations in ${rules.windowDays}d, ` +
      `validated lower bound ${lower.toFixed(3)} ≥ ${rules.lowerFloor}, no high-stakes failures — a human may now grant autonomy ` +
      `(standing audit rate ≥ ${AUDIT_RATE_FLOOR})`,
    evidence: {
      n: inWindow.length,
      successes,
      successLower95: lower,
      windowDays: rules.windowDays,
      highStakesFailures: 0,
      distinctSituations: eff.distinctSituations,
      effectiveN: eff.effectiveN,
    },
  };
}

/** The audit-rate invariant for a state transition: autonomous classes keep
 * the permanent sampling floor; supervised/blocked are fully observed. */
export function auditRateFor(state: GrantState, requested?: number): number {
  if (state !== 'autonomous') return 1;
  return Math.max(AUDIT_RATE_FLOOR, Math.min(1, requested ?? AUDIT_RATE_FLOOR));
}
