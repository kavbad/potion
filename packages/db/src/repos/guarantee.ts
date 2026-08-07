// Quality-guarantee repository + breach evaluator (M3, ROADMAP #22, SPEC
// §12.5, migration 0008).
//
//   quality_samples — append-only per-sample quality of SERVED answers,
//     written fire-and-forget after the response (never on the latency path).
//   incidents       — webhook-ready incident trail; the LATEST UNRESOLVED
//     kind='rollback' incident for (org, cluster) doubles as the serving
//     path's operating-point override (documented in schema.ts + the chat
//     route): the migration contract adds exactly two tables, so the
//     override state lives in the incident row itself and RESOLVING the
//     incident is what restores normal policy routing.
//
// The breach evaluator (evaluateGuarantee) is the single decision point for
// both trigger paths — the server's per-sample evaluation and the worker's
// periodic guarantee:evaluate sweep (ROADMAP #28). It is org-scoped by
// construction (every query filters org_id).
//
// ROLLBACK TARGET PRECEDENCE (documented contract): the PREVIOUS frontier
// version's equivalent point is tried FIRST (the incident says
// source='previous-version'); only when no previous version exists does the
// evaluator fall back to the next-higher-quality point on the CURRENT
// version (source='current-version'). "Equivalent point" on the previous
// version = what selectPoint(policy) would have chosen there, falling back
// to that version's highest-quality point when the policy was infeasible on
// it (same §8 NULL-fallback rule as the serving path).
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  selectPoint,
  type Frontier,
  type FrontierPoint,
  type Policy,
} from '@potion/core';
import { BOOTSTRAP_RESAMPLES, bootstrapMeanCi, seedFromString, sha256 } from '@potion/core';
import type { PotionDb } from '../db.js';
import {
  incidents,
  policies,
  qualitySamples,
  type IncidentKind,
  type IncidentRow,
  type NewIncident,
  type NewQualitySample,
  type QualitySampleRow,
} from '../schema.js';
import { getFrontierById, getLatestFrontier } from './frontiers.js';
import { activeIncumbent } from './cluster-incumbents.js';

/** Minimum evidence before a breach may fire (SPEC §12.5: below that,
 * insufficient evidence → no action). */
export const GUARANTEE_MIN_SAMPLES = 5;

// ---------------------------------------------------------------------------
// quality_samples
// ---------------------------------------------------------------------------

/** Insert one served-answer quality sample. Returns the generated uuid. */
export async function insertQualitySample(db: PotionDb, row: NewQualitySample): Promise<string> {
  const inserted = await db
    .insert(qualitySamples)
    .values(row)
    .returning({ id: qualitySamples.id });
  return inserted[0]!.id;
}

export interface RollingQuality {
  /** Rolling mean over the window; null when there are no samples. */
  mean: number | null;
  samples: number;
}

function windowCutoff(windowMin: number, now: Date): string {
  return new Date(now.getTime() - windowMin * 60_000).toISOString();
}

/** Most-recent samples fetched per keyed window (bootstrap input bound). */
export const WINDOW_EVIDENCE_LIMIT = 1000;

/**
 * The keyed evidence window (G0.3): the actual quality values (newest first,
 * capped at WINDOW_EVIDENCE_LIMIT) for STRICTLY
 * (org, policy, cluster, strategy) within windowMin. NULL-key rows
 * (pre-G0.3) are not evidence — they are excluded by the key predicates.
 */
export async function windowEvidence(
  db: PotionDb,
  scope: {
    orgId: string;
    policyId: string;
    clusterId: string;
    strategyHash: string;
    windowMin: number;
  },
  now: Date = new Date(),
): Promise<{ qualities: number[]; samples: number; mean: number | null }> {
  const result = await db.execute(
    sql`SELECT quality
        FROM quality_samples
        WHERE org_id = ${scope.orgId}
          AND policy_id = ${scope.policyId}
          AND cluster_id = ${scope.clusterId}
          AND strategy_hash = ${scope.strategyHash}
          AND created_at > ${windowCutoff(scope.windowMin, now)}::timestamptz
        ORDER BY created_at DESC
        LIMIT ${WINDOW_EVIDENCE_LIMIT}`,
  );
  const qualities = (result.rows as Array<{ quality: number }>).map((r) => r.quality);
  const mean =
    qualities.length > 0 ? qualities.reduce((a, q) => a + q, 0) / qualities.length : null;
  return { qualities, samples: qualities.length, mean };
}

/** Rolling mean + count for (org, policy) over windowMin — the per-policy
 * number behind GET /api/guarantee/status (keyed evidence only). */
export async function rollingQualityForPolicy(
  db: PotionDb,
  scope: { orgId: string; policyId: string; windowMin: number },
  now: Date = new Date(),
): Promise<RollingQuality> {
  const result = await db.execute(
    sql`SELECT avg(quality)::float8 AS mean, count(*)::int AS samples
        FROM quality_samples
        WHERE org_id = ${scope.orgId}
          AND policy_id = ${scope.policyId}
          AND created_at > ${windowCutoff(scope.windowMin, now)}::timestamptz`,
  );
  const row = (result.rows as Array<{ mean: number | null; samples: number }>)[0];
  return { mean: row?.mean ?? null, samples: row?.samples ?? 0 };
}

/** Distinct keyed evidence tuples an org sampled within `withinMin` —
 * the periodic guarantee:evaluate sweep's work set (G0.3: replaces the
 * strategies × clustersForStrategy cartesian reconstruction). NULL-key
 * rows are not evidence and are excluded. */
export async function distinctSampledTargets(
  db: PotionDb,
  orgId: string,
  withinMin: number,
  now: Date = new Date(),
): Promise<Array<{ policyId: string; clusterId: string; strategyHash: string }>> {
  const result = await db.execute(
    sql`SELECT DISTINCT policy_id, cluster_id, strategy_hash
        FROM quality_samples
        WHERE org_id = ${orgId}
          AND policy_id IS NOT NULL
          AND cluster_id IS NOT NULL
          AND created_at > ${windowCutoff(withinMin, now)}::timestamptz`,
  );
  return (result.rows as Array<{ policy_id: string; cluster_id: string; strategy_hash: string }>).map(
    (r) => ({ policyId: r.policy_id, clusterId: r.cluster_id, strategyHash: r.strategy_hash }),
  );
}

/** All samples for an org (status API / tests), newest first. */
export async function listQualitySamples(
  db: PotionDb,
  orgId: string,
  limit = 100,
): Promise<QualitySampleRow[]> {
  return db
    .select()
    .from(qualitySamples)
    .where(eq(qualitySamples.orgId, orgId))
    .orderBy(desc(qualitySamples.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// incidents
// ---------------------------------------------------------------------------

/** Insert one incident. Returns the generated uuid. */
export async function insertIncident(db: PotionDb, row: NewIncident): Promise<string> {
  const inserted = await db.insert(incidents).values(row).returning({ id: incidents.id });
  return inserted[0]!.id;
}

/** Cooldown check: an incident already exists for (org, policy, cluster,
 * strategy) within the last windowMin minutes → suppress (no flapping).
 * G0.3: the policy key means two policies breaching on the same strategy
 * each get their own incident (they have independent floors). Pre-G0.3
 * incidents lack detail.policyId and never match — one extra incident per
 * key across the upgrade, then normal cooldown. */
export async function hasRecentIncident(
  db: PotionDb,
  scope: {
    orgId: string;
    policyId: string;
    clusterId: string;
    fromStrategy: string;
    windowMin: number;
  },
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        eq(incidents.orgId, scope.orgId),
        gt(incidents.createdAt, new Date(windowCutoff(scope.windowMin, now))),
        sql`${incidents.detail} ->> 'policyId' = ${scope.policyId}`,
        sql`${incidents.detail} ->> 'clusterId' = ${scope.clusterId}`,
        sql`${incidents.detail} ->> 'fromStrategy' = ${scope.fromStrategy}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Incident list for the status API + dashboard: ALL unresolved incidents
 * plus the most recent `resolvedLimit` resolved ones, newest first within
 * each group (unresolved first).
 */
export async function listIncidents(
  db: PotionDb,
  orgId: string,
  resolvedLimit = 20,
): Promise<IncidentRow[]> {
  const unresolved = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.orgId, orgId), isNull(incidents.resolvedAt)))
    .orderBy(desc(incidents.createdAt));
  const resolved = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.orgId, orgId), sql`${incidents.resolvedAt} IS NOT NULL`))
    .orderBy(desc(incidents.createdAt))
    .limit(resolvedLimit);
  return [...unresolved, ...resolved];
}

/**
 * Resolve an incident (admin flow). Returns the updated row, or null when
 * the incident does not exist FOR THIS ORG (cross-org resolves are
 * impossible by construction) — an already-resolved incident returns null
 * too (the API maps both to 404; resolving twice is not an error worth a
 * distinct state).
 */
export async function resolveIncident(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<IncidentRow | null> {
  const updated = await db
    .update(incidents)
    .set({ resolvedAt: new Date() })
    .where(
      and(eq(incidents.id, id), eq(incidents.orgId, orgId), isNull(incidents.resolvedAt)),
    )
    .returning();
  return updated[0] ?? null;
}

/**
 * The serving path's operating-point override: the LATEST UNRESOLVED
 * kind='rollback' incident for (org, cluster). Resolving the incident lifts
 * the override (policy routing resumes).
 */
export async function latestActiveRollback(
  db: PotionDb,
  orgId: string,
  clusterId: string,
): Promise<IncidentRow | null> {
  const rows = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.orgId, orgId),
        eq(incidents.kind, 'rollback'),
        isNull(incidents.resolvedAt),
        sql`${incidents.detail} ->> 'clusterId' = ${clusterId}`,
      ),
    )
    .orderBy(desc(incidents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// sweep support (worker guarantee:evaluate periodic mode)
// ---------------------------------------------------------------------------

/** Policies carrying a guarantee config, optionally scoped to one org. */
export async function listPoliciesWithGuarantee(
  db: PotionDb,
  orgId?: string,
): Promise<Array<{ id: string; orgId: string; config: Policy }>> {
  const rows = await db
    .select({ id: policies.id, orgId: policies.orgId, config: policies.config })
    .from(policies)
    .where(
      and(
        sql`${policies.config} ? 'guarantee'`,
        orgId !== undefined ? eq(policies.orgId, orgId) : undefined,
      ),
    );
  return rows.filter((r) => r.config.guarantee !== undefined);
}

/**
 * Gap-filled per-day quality series for one (org, policy, cluster) over
 * [fromDay, toDay] UTC inclusive (G2.1 report; dailySpendSeries cursor
 * shape). Days without samples report mean:null + samples:0 — quality has
 * no zero-fill semantics (a quiet day is not a bad day).
 */
export async function qualitySeriesDaily(
  db: PotionDb,
  scope: { orgId: string; policyId: string; clusterId: string },
  range: { fromDay: string; toDay: string },
): Promise<Array<{ day: string; mean: number | null; samples: number }>> {
  const result = await db.execute(
    sql`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               avg(quality)::float8 AS mean,
               count(*)::int AS samples
        FROM quality_samples
        WHERE org_id = ${scope.orgId}
          AND policy_id = ${scope.policyId}
          AND cluster_id = ${scope.clusterId}
          AND created_at >= ${`${range.fromDay}T00:00:00.000Z`}::timestamptz
          AND created_at < (${`${range.toDay}T00:00:00.000Z`}::timestamptz + interval '1 day')
        GROUP BY 1`,
  );
  const byDay = new Map<string, { mean: number; samples: number }>();
  for (const r of result.rows as Array<{ day: string; mean: number; samples: number }>) {
    byDay.set(r.day, { mean: r.mean, samples: r.samples });
  }
  const out: Array<{ day: string; mean: number | null; samples: number }> = [];
  const cursor = new Date(`${range.fromDay}T00:00:00Z`);
  const end = new Date(`${range.toDay}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    const day = cursor.toISOString().slice(0, 10);
    const hit = byDay.get(day);
    out.push({ day, mean: hit?.mean ?? null, samples: hit?.samples ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// derived serve floor (G2.1 trust hierarchy — advisory leg)
// ---------------------------------------------------------------------------

/** Everything needed to re-derive a serve floor — attached to every
 * advisory incident (a floor without provenance is a test failure). */
export interface ServeFloorProvenance {
  n: number;
  mean: number;
  ci95: [number, number];
  seed: number;
  resamples: number;
  /** The baseline window actually queried (2× the candidate's windowMin). */
  windowMin: number;
  incumbentHash: string;
}

export interface DerivedServeFloor {
  /** CI95 LOWER bound of the incumbent's own serve-path window mean; null =
   * insufficient baseline evidence (caller suppresses, surfaced). */
  floor: number | null;
  provenance: ServeFloorProvenance | null;
  /** Baseline sample count (reported even when insufficient). */
  samples: number;
}

/**
 * Derive the serve-path advisory floor from the INCUMBENT's OWN serve-path
 * distribution (G2.1 standing decision: floors derive from the baseline's
 * measured distribution, never absolute numbers — and both sides of the
 * comparison are reference-free serve scores, so the scales match).
 *
 * Floor = seeded-bootstrap CI95 LOWER bound of the incumbent's window mean
 * over 2× the candidate's windowMin (steadier baseline than the candidate's
 * own window). Derived FRESH at every evaluation, never persisted — the
 * floor self-corrects as the incumbent's serve distribution drifts.
 */
export async function deriveServeFloor(
  db: PotionDb,
  scope: {
    orgId: string;
    policyId: string;
    clusterId: string;
    incumbentHash: string;
    /** The CANDIDATE's window; the baseline queries 2× this. */
    windowMin: number;
    minSamples: number;
  },
  now: Date = new Date(),
): Promise<DerivedServeFloor> {
  const baselineWindowMin = scope.windowMin * 2;
  const evidence = await windowEvidence(
    db,
    {
      orgId: scope.orgId,
      policyId: scope.policyId,
      clusterId: scope.clusterId,
      strategyHash: scope.incumbentHash,
      windowMin: baselineWindowMin,
    },
    now,
  );
  if (evidence.samples < scope.minSamples || evidence.mean === null) {
    return { floor: null, provenance: null, samples: evidence.samples };
  }
  const seed = seedFromString(
    `serve-floor|${scope.orgId}|${scope.policyId}|${scope.clusterId}|${scope.incumbentHash}|` +
      `${evidence.samples}|${sha256(JSON.stringify(evidence.qualities))}`,
  );
  const { ci95 } = bootstrapMeanCi(evidence.qualities, seed, BOOTSTRAP_RESAMPLES);
  return {
    floor: ci95[0],
    provenance: {
      n: evidence.samples,
      mean: evidence.mean,
      ci95: ci95 as [number, number],
      seed,
      resamples: BOOTSTRAP_RESAMPLES,
      windowMin: baselineWindowMin,
      incumbentHash: scope.incumbentHash,
    },
    samples: evidence.samples,
  };
}

/** An OPEN advisory for the same evidence tuple — the advisory dedupe
 * gate (one open tripwire per tuple; suite-verify resolves it). */
export async function openAdvisoryForTuple(
  db: PotionDb,
  scope: { orgId: string; policyId: string; clusterId: string; fromStrategy: string },
): Promise<IncidentRow | null> {
  const rows = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.orgId, scope.orgId),
        eq(incidents.kind, 'advisory'),
        isNull(incidents.resolvedAt),
        sql`${incidents.detail} ->> 'policyId' = ${scope.policyId}`,
        sql`${incidents.detail} ->> 'clusterId' = ${scope.clusterId}`,
        sql`${incidents.detail} ->> 'fromStrategy' = ${scope.fromStrategy}`,
      ),
    )
    .orderBy(desc(incidents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve an ADVISORY incident WITH its outcome evidence (G2.1): the
 * suite-verify verdict — escalated or all-clear — is merged into the
 * advisory's detail as `resolution` before resolvedAt is set, so the
 * tripwire row itself records how it was disposed ('all-clear' is a
 * durable record, not a deletion). Returns null when no open advisory
 * matches (already resolved / wrong org / not an advisory).
 */
export async function resolveAdvisoryWithEvidence(
  db: PotionDb,
  orgId: string,
  id: string,
  resolution: Record<string, unknown>,
): Promise<IncidentRow | null> {
  const rows = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.id, id),
        eq(incidents.orgId, orgId),
        eq(incidents.kind, 'advisory'),
        isNull(incidents.resolvedAt),
      ),
    );
  const row = rows[0];
  if (!row) return null;
  const updated = await db
    .update(incidents)
    .set({
      detail: { ...(row.detail as Record<string, unknown>), resolution },
      resolvedAt: new Date(),
    })
    .where(eq(incidents.id, id))
    .returning();
  return updated[0] ?? null;
}

// ---------------------------------------------------------------------------
// breach evaluation
// ---------------------------------------------------------------------------

/** Highest-quality point (tie → lower cost) — the §8 NULL-fallback rule. */
export function highestQualityPoint(points: FrontierPoint[]): FrontierPoint | null {
  if (points.length === 0) return null;
  return [...points].sort((a, b) => b.quality - a.quality || a.costPer1K - b.costPer1K)[0] ?? null;
}

/** The "equivalent point" on a previous frontier version: what the policy
 * would have selected there, else that version's highest-quality point. */
export function equivalentPointOnPrevious(
  policy: Policy,
  previous: Frontier,
): FrontierPoint | null {
  return selectPoint(policy, previous) ?? highestQualityPoint(previous.points);
}

/**
 * Next-higher-quality point on the CURRENT version relative to the
 * breaching strategy's frontier point (smallest quality strictly above the
 * breaching point's, tie → lower cost). When the breaching strategy is not
 * on the current frontier (served via the no-frontier default), the
 * documented safe choice is the current version's HIGHEST-quality point.
 * null when the breaching point already tops the frontier (nowhere up).
 */
export function nextHigherQualityPoint(
  points: FrontierPoint[],
  fromStrategyHash: string,
): FrontierPoint | null {
  const from = points.find((p) => p.strategyHash === fromStrategyHash);
  if (!from) return highestQualityPoint(points);
  const above = points
    .filter((p) => p.quality > from.quality)
    .sort((a, b) => a.quality - b.quality || a.costPer1K - b.costPer1K);
  return above[0] ?? null;
}

export interface RollbackTarget {
  strategyHash: string;
  frontierVersion: number;
  /** 'previous-version' always takes precedence; 'current-version' only when
   * no previous version exists (documented contract, see header). */
  source: 'previous-version' | 'current-version';
}

/** Resolve the rollback target for (cluster, policy, breaching strategy). */
export async function resolveRollbackTarget(
  db: PotionDb,
  scope: { clusterId: string; policy: Policy; fromStrategyHash: string },
): Promise<RollbackTarget | null> {
  const current = await getLatestFrontier(db, scope.clusterId);
  // 1. PREVIOUS VERSION FIRST (precedence contract): walk the parent chain
  //    (parentId IS the previous version by construction — see saveFrontier).
  const previous = current?.parentId ? await getFrontierById(db, current.parentId) : null;
  if (previous && previous.points.length > 0) {
    const equivalent = equivalentPointOnPrevious(scope.policy, previous);
    if (equivalent) {
      return {
        strategyHash: equivalent.strategyHash,
        frontierVersion: previous.version,
        source: 'previous-version',
      };
    }
  }
  // 2. Fallback: next-higher-quality point on the CURRENT version.
  if (current && current.points.length > 0) {
    const next = nextHigherQualityPoint(current.points, scope.fromStrategyHash);
    if (next) {
      return {
        strategyHash: next.strategyHash,
        frontierVersion: current.version,
        source: 'current-version',
      };
    }
  }
  return null;
}

export interface GuaranteeEvaluation {
  rollingQuality: number | null;
  samples: number;
  /** 'hierarchy' when an incumbent is designated (G2.1): the serve leg is
   * ADVISORY-only against the derived floor and `breach` is structurally
   * false — only suite-verify evidence renders the contractual verdict.
   * 'legacy' (no incumbent): the pre-G2.1 absolute-minQuality path,
   * byte-for-byte. */
  mode: 'legacy' | 'hierarchy';
  /** Hierarchy-mode advisory outcome (null in legacy mode). `triggered`
   * is true ONLY when a NEW advisory incident was minted this evaluation —
   * the caller's suite-verify enqueue signal. A crossing with an already-
   * open advisory reports deduped=true, triggered=false (the open
   * tripwire's verify is already pending). */
  advisory: {
    triggered: boolean;
    incidentId: string | null;
    deduped: boolean;
    floor: number;
    provenance: ServeFloorProvenance;
  } | null;
  breach: boolean;
  /** The configured action that fired (null when suppressed). */
  action: 'rollback' | 'alert' | null;
  incidentId: string | null;
  /** Why no incident was written (null = an incident was written).
   * 'not-significant' (G0.3): observed mean below the floor but the CI95
   * straddles it — the at-risk state; visible, never an incident. */
  suppressed:
    | 'insufficient-evidence'
    | 'no-breach'
    | 'not-significant'
    | 'cooldown'
    | 'insufficient-baseline'
    | null;
  /** 95% bootstrap CI on the window mean (null before the CI stage runs —
   * insufficient evidence or observed mean at/above the floor). */
  ci95: [number, number] | null;
  /** Seed the CI was computed with (audit re-derivation) — null when no CI. */
  seed: number | null;
  /** The evidence floor this evaluation applied (config or platform 5). */
  minSamplesRequired: number;
  /** Set when a rollback target was chosen (incident kind='rollback'). */
  rollback: {
    fromStrategy: string;
    toStrategy: string;
    toFrontierVersion: number;
    source: RollbackTarget['source'];
  } | null;
}

/**
 * Evaluate the keyed rolling quality window for (org, policy, cluster,
 * strategy) against the policy's guarantee and fire the configured action
 * exactly once per window (cooldown). NEVER throws on business outcomes —
 * every outcome is reported in the return value; only db errors propagate.
 *
 * G0.3 decision contract: a breach fires only when the seeded 95% bootstrap
 * CI's UPPER bound on the window mean is below minQuality — statistically
 * confident the true mean is under the floor, the same "CI bound must clear
 * the line" rigor as the researcher promotion gate, pointed in the breach
 * direction. Observed-below-floor with a straddling CI is 'not-significant':
 * reported, never an incident. The seed derives from the evidence itself
 * (seedFromString) and is stored in the incident detail — every verdict is
 * re-derivable.
 *
 * Requires policy.guarantee (callers gate on it); throws otherwise.
 */
export async function evaluateGuarantee(
  db: PotionDb,
  input: {
    orgId: string;
    policyId: string;
    clusterId: string;
    strategyHash: string;
    policy: Policy;
  },
  now: Date = new Date(),
): Promise<GuaranteeEvaluation> {
  const guarantee = input.policy.guarantee;
  if (!guarantee) {
    throw new Error('evaluateGuarantee requires a policy with a guarantee config');
  }
  const minSamples = guarantee.minSamples ?? GUARANTEE_MIN_SAMPLES;
  const evidence = await windowEvidence(
    db,
    {
      orgId: input.orgId,
      policyId: input.policyId,
      clusterId: input.clusterId,
      strategyHash: input.strategyHash,
      windowMin: guarantee.windowMin,
    },
    now,
  );
  const base = {
    rollingQuality: evidence.mean,
    samples: evidence.samples,
    mode: 'legacy' as const,
    advisory: null,
    incidentId: null,
    ci95: null,
    seed: null,
    minSamplesRequired: minSamples,
    rollback: null,
  };
  // TRUST HIERARCHY (G2.1): a designated incumbent switches the serve leg
  // to advisory-only mode — the absolute minQuality is ignored (workload-
  // specific scales make it meaningless) and floor crossings enqueue an
  // anchored suite re-eval instead of acting.
  const incumbent = await activeIncumbent(db, input.orgId, input.clusterId);
  if (incumbent) {
    return evaluateAdvisoryLeg(db, input, { guarantee, minSamples, evidence, incumbent }, now);
  }
  // Insufficient evidence: below the configured floor, never act.
  if (evidence.samples < minSamples) {
    return { ...base, breach: false, action: null, suppressed: 'insufficient-evidence' };
  }
  const mean = evidence.mean ?? 0;
  // Recovery / healthy: observed mean at or above the floor → no incident.
  if (mean >= guarantee.minQuality) {
    return { ...base, breach: false, action: null, suppressed: 'no-breach' };
  }
  // CI stage: seeded from the evidence itself — auditable re-derivation.
  const seed = seedFromString(
    `${input.orgId}|${input.policyId}|${input.clusterId}|${input.strategyHash}|` +
      `${evidence.samples}|${sha256(JSON.stringify(evidence.qualities))}`,
  );
  const { ci95 } = bootstrapMeanCi(evidence.qualities, seed, BOOTSTRAP_RESAMPLES);
  const ciBase = { ...base, ci95: ci95 as [number, number], seed };
  if (ci95[1] >= guarantee.minQuality) {
    // Observed below the floor but not statistically confident: at-risk,
    // reported, no incident.
    return { ...ciBase, breach: false, action: null, suppressed: 'not-significant' };
  }
  // Cooldown: one incident per (org, policy, cluster, strategy) per window.
  if (
    await hasRecentIncident(
      db,
      {
        orgId: input.orgId,
        policyId: input.policyId,
        clusterId: input.clusterId,
        fromStrategy: input.strategyHash,
        windowMin: guarantee.windowMin,
      },
      now,
    )
  ) {
    return { ...ciBase, breach: true, action: null, suppressed: 'cooldown' };
  }

  const detailBase = {
    policyId: input.policyId,
    clusterId: input.clusterId,
    fromStrategy: input.strategyHash,
    rollingQuality: mean,
    ci95,
    seed,
    resamples: BOOTSTRAP_RESAMPLES,
    minQuality: guarantee.minQuality,
    minSamples,
    windowMin: guarantee.windowMin,
    samples: evidence.samples,
  };

  if (guarantee.action === 'alert') {
    const incidentId = await insertIncident(db, {
      orgId: input.orgId,
      kind: 'quality_breach' satisfies IncidentKind,
      detail: detailBase,
    });
    return { ...ciBase, breach: true, action: 'alert', incidentId, suppressed: null };
  }

  // action === 'rollback'
  const target = await resolveRollbackTarget(db, {
    clusterId: input.clusterId,
    policy: input.policy,
    fromStrategyHash: input.strategyHash,
  });
  if (!target) {
    // Nowhere safer to go (no previous version, already at the top of the
    // current one, or no frontier at all): the breach is still recorded —
    // as kind='quality_breach' with the intended action + reason, NO
    // operating-point change (documented no-target behavior).
    const incidentId = await insertIncident(db, {
      orgId: input.orgId,
      kind: 'quality_breach' satisfies IncidentKind,
      detail: { ...detailBase, intendedAction: 'rollback', reason: 'no-rollback-target' },
    });
    return { ...ciBase, breach: true, action: 'rollback', incidentId, suppressed: null };
  }
  const incidentId = await insertIncident(db, {
    orgId: input.orgId,
    kind: 'rollback' satisfies IncidentKind,
    detail: {
      ...detailBase,
      toStrategy: target.strategyHash,
      toFrontierVersion: target.frontierVersion,
      targetSource: target.source,
    },
  });
  return {
    ...ciBase,
    breach: true,
    action: 'rollback',
    incidentId,
    suppressed: null,
    rollback: {
      fromStrategy: input.strategyHash,
      toStrategy: target.strategyHash,
      toFrontierVersion: target.frontierVersion,
      source: target.source,
    },
  };
}

/**
 * The advisory serve leg (G2.1 trust hierarchy). Mirrors the legacy CI
 * rigor with the derived floor in minQuality's place: a crossing fires
 * only when the candidate window mean's seeded CI95 UPPER bound is below
 * the incumbent-derived floor. Crossings mint kind='advisory' incidents
 * ONLY — never quality_breach/rollback, never an operating-point change —
 * and `advisory.triggered` is the caller's signal to enqueue
 * guarantee:suite-verify (the contractual leg).
 */
async function evaluateAdvisoryLeg(
  db: PotionDb,
  input: {
    orgId: string;
    policyId: string;
    clusterId: string;
    strategyHash: string;
    policy: Policy;
  },
  ctx: {
    guarantee: NonNullable<Policy['guarantee']>;
    minSamples: number;
    evidence: { qualities: number[]; samples: number; mean: number | null };
    incumbent: { id: string; strategyHash: string };
  },
  now: Date,
): Promise<GuaranteeEvaluation> {
  const { guarantee, minSamples, evidence, incumbent } = ctx;
  const base = {
    rollingQuality: evidence.mean,
    samples: evidence.samples,
    mode: 'hierarchy' as const,
    advisory: null,
    breach: false as const,
    action: null,
    incidentId: null,
    ci95: null,
    seed: null,
    minSamplesRequired: minSamples,
    rollback: null,
  };
  if (evidence.samples < minSamples) {
    return { ...base, suppressed: 'insufficient-evidence' };
  }
  const floorRes = await deriveServeFloor(
    db,
    {
      orgId: input.orgId,
      policyId: input.policyId,
      clusterId: input.clusterId,
      incumbentHash: incumbent.strategyHash,
      windowMin: guarantee.windowMin,
      minSamples,
    },
    now,
  );
  if (floorRes.floor === null || floorRes.provenance === null) {
    // The incumbent itself lacks serve-path evidence: no floor can be
    // derived, nothing fires — surfaced, never silent.
    return { ...base, suppressed: 'insufficient-baseline' };
  }
  const floor = floorRes.floor;
  const provenance = floorRes.provenance;
  const mean = evidence.mean ?? 0;
  if (mean >= floor) {
    return { ...base, suppressed: 'no-breach' };
  }
  const seed = seedFromString(
    `${input.orgId}|${input.policyId}|${input.clusterId}|${input.strategyHash}|` +
      `${evidence.samples}|${sha256(JSON.stringify(evidence.qualities))}`,
  );
  const { ci95 } = bootstrapMeanCi(evidence.qualities, seed, BOOTSTRAP_RESAMPLES);
  const ciBase = { ...base, ci95: ci95 as [number, number], seed };
  if (ci95[1] >= floor) {
    return { ...ciBase, suppressed: 'not-significant' };
  }
  // Dedupe: one OPEN advisory per tuple — its suite-verify is already
  // pending, so no new row and no new enqueue signal.
  const open = await openAdvisoryForTuple(db, {
    orgId: input.orgId,
    policyId: input.policyId,
    clusterId: input.clusterId,
    fromStrategy: input.strategyHash,
  });
  if (open) {
    return {
      ...ciBase,
      suppressed: 'cooldown',
      advisory: { triggered: false, incidentId: open.id, deduped: true, floor, provenance },
    };
  }
  const incidentId = await insertIncident(db, {
    orgId: input.orgId,
    kind: 'advisory' satisfies IncidentKind,
    detail: {
      leg: 'serve',
      policyId: input.policyId,
      clusterId: input.clusterId,
      fromStrategy: input.strategyHash,
      rollingQuality: mean,
      ci95,
      seed,
      resamples: BOOTSTRAP_RESAMPLES,
      samples: evidence.samples,
      windowMin: guarantee.windowMin,
      minSamples,
      floor,
      floorProvenance: provenance,
      incumbent: { hash: incumbent.strategyHash, designationId: incumbent.id },
      note: 'advisory tripwire — contractual verdict pending suite-verify',
    },
  });
  return {
    ...ciBase,
    suppressed: null,
    incidentId,
    advisory: { triggered: true, incidentId, deduped: false, floor, provenance },
  };
}
