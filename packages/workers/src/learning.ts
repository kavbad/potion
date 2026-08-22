// THE AUTONOMOUS PROBE (SERVING-ROADMAP S7 L4) — deciding what to measure
// next, and whether it is allowed to.
//
// This is the leg where the loop stops observing and starts spending, so the
// planning is separated from the execution deliberately: `planProbe` decides
// and explains, `learningProbeHandler` (handlers.ts) acts. Everything about
// authorization, gap choice and cap arithmetic is therefore testable without
// a provider key, and a `dryRun` gives the operator the same plan the job
// would have executed.
//
// THE STANDING AUTHORIZATION (operator ruling, S7 §4 D2). Every live campaign
// in this project has been ledgered under an explicit per-run risk
// acceptance. L4 replaces the per-run human with a daily cap the operator can
// switch on and off — and DEFAULTS IT TO OFF. With the cap unset the loop
// still discovers, ranks and plans; it simply cannot buy. That is the same
// mechanism as "propose, don't buy", which is why it is one build.
import { spentTodayUsd, type PotionDb } from '@potion/db';
import { rankCoverageGaps, type CoverageGap } from '@potion/pareto';

export interface LearningAutonomy {
  /** False when the daily cap is unset or zero: plan, never spend. */
  enabled: boolean;
  /** Total USD autonomous learning may commit per UTC day. */
  dailyCapUsd: number;
  /** Ceiling for any single run. */
  perRunCapUsd: number;
  /** Score multiplier for cells a priority org contributed to (premium). */
  priorityWeight: number;
}

/** Default single-run ceiling when only a daily cap is configured. */
export const DEFAULT_PER_RUN_CAP_USD = 2;
/** Default premium weighting. */
export const DEFAULT_PRIORITY_WEIGHT = 2;

export function learningAutonomyFromEnv(env = process.env): LearningAutonomy {
  const daily = Number(env.POTION_AUTONOMOUS_LEARNING_DAILY_USD ?? 0);
  const perRun = Number(env.POTION_AUTONOMOUS_LEARNING_PER_RUN_USD ?? 0);
  const weight = Number(env.POTION_LEARNING_PRIORITY_WEIGHT ?? DEFAULT_PRIORITY_WEIGHT);
  const dailyCapUsd = Number.isFinite(daily) && daily > 0 ? daily : 0;
  const configuredPerRun = Number.isFinite(perRun) && perRun > 0 ? perRun : DEFAULT_PER_RUN_CAP_USD;
  return {
    enabled: dailyCapUsd > 0,
    dailyCapUsd,
    // A per-run ceiling above the daily cap is meaningless; the day wins.
    perRunCapUsd: Math.min(configuredPerRun, dailyCapUsd || configuredPerRun),
    priorityWeight: Number.isFinite(weight) && weight > 0 ? weight : DEFAULT_PRIORITY_WEIGHT,
  };
}

export type ProbeRefusalReason =
  /** No standing authorization: the daily cap is unset or zero. */
  | 'not-authorized'
  /** Today's cap is already committed. */
  | 'daily-cap-exhausted'
  /** Nothing is uncovered — the happy refusal. */
  | 'no-gaps'
  /** Gaps exist, but none can be closed by a sweep (see `skipped`). */
  | 'no-sweepable-gap';

export interface ProbePlan {
  gap: CoverageGap;
  clusterId: string;
  capUsd: number;
  capabilityFilter?: { tools?: boolean; minContextTokens?: number };
  /** Gaps ranked above this one that no sweep can close, with the reason. */
  skipped: Array<{ cellKey: string; reason: string }>;
}

export interface ProbeRefusal {
  refusal: ProbeRefusalReason;
  detail: string;
  skipped: Array<{ cellKey: string; reason: string }>;
}

export type ProbeDecision = ProbePlan | ProbeRefusal;

export function isRefusal(d: ProbeDecision): d is ProbeRefusal {
  return 'refusal' in d;
}

/**
 * The capability narrowing a gap implies.
 *
 * This is why `CoverageReason` is data rather than prose: the reason a cell
 * is uncovered IS the filter the sweep must apply to close it. A
 * `no_tool_capable_point` gap measured over tool-incapable models would
 * spend money, report new points, and leave the gap open.
 */
export function capabilityFilterFor(
  gap: CoverageGap,
): { tools?: boolean; minContextTokens?: number } | undefined {
  switch (gap.reason) {
    case 'no_tool_capable_point':
      return { tools: true };
    case 'context_too_short':
      return { minContextTokens: gap.requiredContextTokens };
    default:
      // no_live_points / thin_evidence: the cluster needs breadth, not a
      // capability. Narrowing here would measure less for the same money.
      return undefined;
  }
}

export interface PlanOptions {
  autonomy: LearningAutonomy;
  /** True when a cluster has a committed platform suite to sweep. */
  isSweepable: (clusterId: string) => boolean;
  now?: Date;
  sinceWeek?: string;
}

/**
 * Choose the next measurement, or explain why there will not be one.
 *
 * Ordering comes from `rankCoverageGaps`, which is total, so two invocations
 * on unchanged data plan the same run.
 */
export async function planProbe(db: PotionDb, opts: PlanOptions): Promise<ProbeDecision> {
  const skipped: Array<{ cellKey: string; reason: string }> = [];
  const { autonomy } = opts;
  if (!autonomy.enabled) {
    return {
      refusal: 'not-authorized',
      detail:
        'POTION_AUTONOMOUS_LEARNING_DAILY_USD is unset or zero — the loop discovers and plans, ' +
        'but no standing authorization exists to spend',
      skipped,
    };
  }

  const now = opts.now ?? new Date();
  const spent = await spentTodayUsd(db, now);
  const remaining = autonomy.dailyCapUsd - spent;
  if (remaining <= 0) {
    return {
      refusal: 'daily-cap-exhausted',
      detail: `$${spent.toFixed(4)} of $${autonomy.dailyCapUsd.toFixed(2)} committed today`,
      skipped,
    };
  }

  const gaps = await rankCoverageGaps(db, {
    ...(opts.sinceWeek !== undefined ? { sinceWeek: opts.sinceWeek } : {}),
    priorityWeight: autonomy.priorityWeight,
  });
  if (gaps.length === 0) {
    return { refusal: 'no-gaps', detail: 'every published demand cell is covered', skipped };
  }

  for (const gap of gaps) {
    if (gap.cell.bucketKind === 'unassigned') {
      // A region that matched no cluster has no suite to sweep. It is real
      // demand and it is REPORTED as skipped rather than dropped — closing
      // it needs a taxonomy proposal (L5), not a measurement.
      skipped.push({ cellKey: gap.cell.cellKey, reason: 'unassigned-region-needs-taxonomy' });
      continue;
    }
    if (!opts.isSweepable(gap.cell.bucket)) {
      skipped.push({ cellKey: gap.cell.cellKey, reason: `no committed suite for '${gap.cell.bucket}'` });
      continue;
    }
    const capUsd = Math.min(autonomy.perRunCapUsd, remaining);
    const filter = capabilityFilterFor(gap);
    return {
      gap,
      clusterId: gap.cell.bucket,
      capUsd,
      ...(filter !== undefined ? { capabilityFilter: filter } : {}),
      skipped,
    };
  }

  return {
    refusal: 'no-sweepable-gap',
    detail: `${gaps.length} gap(s) ranked, none closable by a platform sweep`,
    skipped,
  };
}

/** Minimal capability view of a catalog row. */
export interface ModelCapability {
  alias: string;
  supportsTools: boolean | null;
  contextLength: number | null;
}

/**
 * Keep only the answerers that can serve the demand a run exists to close.
 *
 * UNKNOWN IS EXCLUDED. `models.supports_tools` and `context_length` are
 * nullable because the provider did not report them, and "did not report"
 * is not "yes": measuring a model that turns out to reject tool definitions
 * spends the budget and leaves the gap open, which is worse than not running.
 */
export function filterByCapability<T extends { alias: string }>(
  pool: readonly T[],
  catalog: ReadonlyMap<string, ModelCapability>,
  filter: { tools?: boolean; minContextTokens?: number },
): T[] {
  return pool.filter((e) => {
    const row = catalog.get(e.alias);
    if (filter.tools === true && row?.supportsTools !== true) return false;
    if (filter.minContextTokens !== undefined) {
      if (row?.contextLength === null || row?.contextLength === undefined) return false;
      if (row.contextLength < filter.minContextTokens) return false;
    }
    return true;
  });
}
