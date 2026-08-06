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

/** Rolling mean quality + sample count for (org, strategy) over windowMin. */
export async function rollingQuality(
  db: PotionDb,
  scope: { orgId: string; strategyHash: string; windowMin: number },
  now: Date = new Date(),
): Promise<RollingQuality> {
  const result = await db.execute(
    sql`SELECT avg(quality)::float8 AS mean, count(*)::int AS samples
        FROM quality_samples
        WHERE org_id = ${scope.orgId}
          AND strategy_hash = ${scope.strategyHash}
          AND created_at > ${windowCutoff(scope.windowMin, now)}::timestamptz`,
  );
  const row = (result.rows as Array<{ mean: number | null; samples: number }>)[0];
  return { mean: row?.mean ?? null, samples: row?.samples ?? 0 };
}

/** Rolling mean over ALL of an org's samples in the window — the per-policy
 * rollup behind GET /api/guarantee/status (samples are strategy-tagged; the
 * per-strategy breakdown uses rollingQuality). */
export async function rollingQualityForOrg(
  db: PotionDb,
  scope: { orgId: string; windowMin: number },
  now: Date = new Date(),
): Promise<RollingQuality> {
  const result = await db.execute(
    sql`SELECT avg(quality)::float8 AS mean, count(*)::int AS samples
        FROM quality_samples
        WHERE org_id = ${scope.orgId}
          AND created_at > ${windowCutoff(scope.windowMin, now)}::timestamptz`,
  );
  const row = (result.rows as Array<{ mean: number | null; samples: number }>)[0];
  return { mean: row?.mean ?? null, samples: row?.samples ?? 0 };
}

/** Distinct strategy hashes an org sampled within the last `withinMin`
 * minutes — the periodic guarantee:evaluate sweep's work set. */
export async function distinctSampledStrategies(
  db: PotionDb,
  orgId: string,
  withinMin: number,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ strategyHash: qualitySamples.strategyHash })
    .from(qualitySamples)
    .where(
      and(
        eq(qualitySamples.orgId, orgId),
        gt(qualitySamples.createdAt, new Date(windowCutoff(withinMin, now))),
      ),
    );
  return rows.map((r) => r.strategyHash);
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

/** Cooldown check: an incident already exists for (org, cluster, strategy)
 * within the last windowMin minutes → suppress (no flapping). */
export async function hasRecentIncident(
  db: PotionDb,
  scope: { orgId: string; clusterId: string; fromStrategy: string; windowMin: number },
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(
      and(
        eq(incidents.orgId, scope.orgId),
        gt(incidents.createdAt, new Date(windowCutoff(scope.windowMin, now))),
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

/** Clusters whose CURRENT (latest-version) frontier contains a strategy —
 * how the periodic sweep recovers the cluster dimension that the
 * quality_samples contract schema deliberately omits. */
export async function clustersForStrategy(db: PotionDb, strategyHash: string): Promise<string[]> {
  const result = await db.execute(
    sql`SELECT DISTINCT fp.cluster_id AS cluster_id
        FROM frontier_points fp
        JOIN frontiers f ON f.id = fp.frontier_id
        WHERE fp.strategy_hash = ${strategyHash}
          AND NOT EXISTS (
            SELECT 1 FROM frontiers f2
            WHERE f2.cluster_id = f.cluster_id AND f2.version > f.version
          )`,
  );
  return (result.rows as Array<{ cluster_id: string }>).map((r) => r.cluster_id);
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
  breach: boolean;
  /** The configured action that fired (null when suppressed). */
  action: 'rollback' | 'alert' | null;
  incidentId: string | null;
  /** Why no incident was written (null = an incident was written). */
  suppressed: 'insufficient-evidence' | 'no-breach' | 'cooldown' | null;
  /** Set when a rollback target was chosen (incident kind='rollback'). */
  rollback: {
    fromStrategy: string;
    toStrategy: string;
    toFrontierVersion: number;
    source: RollbackTarget['source'];
  } | null;
}

/**
 * Evaluate the rolling quality window for (org, cluster, strategy) against
 * the policy's guarantee and fire the configured action exactly once per
 * window (cooldown). NEVER throws on business outcomes — every outcome is
 * reported in the return value; only db errors propagate.
 *
 * Requires policy.guarantee (callers gate on it); throws otherwise.
 */
export async function evaluateGuarantee(
  db: PotionDb,
  input: { orgId: string; clusterId: string; strategyHash: string; policy: Policy },
  now: Date = new Date(),
): Promise<GuaranteeEvaluation> {
  const guarantee = input.policy.guarantee;
  if (!guarantee) {
    throw new Error('evaluateGuarantee requires a policy with a guarantee config');
  }
  const rolling = await rollingQuality(
    db,
    { orgId: input.orgId, strategyHash: input.strategyHash, windowMin: guarantee.windowMin },
    now,
  );
  const base = {
    rollingQuality: rolling.mean,
    samples: rolling.samples,
    incidentId: null,
    rollback: null,
  };
  // Insufficient evidence: below GUARANTEE_MIN_SAMPLES, never act.
  if (rolling.samples < GUARANTEE_MIN_SAMPLES) {
    return { ...base, breach: false, action: null, suppressed: 'insufficient-evidence' };
  }
  const mean = rolling.mean ?? 0;
  // Recovery / healthy: at or above the floor → no incident.
  if (mean >= guarantee.minQuality) {
    return { ...base, breach: false, action: null, suppressed: 'no-breach' };
  }
  // Cooldown: one incident per (org, cluster, strategy) per window.
  if (
    await hasRecentIncident(
      db,
      {
        orgId: input.orgId,
        clusterId: input.clusterId,
        fromStrategy: input.strategyHash,
        windowMin: guarantee.windowMin,
      },
      now,
    )
  ) {
    return { ...base, breach: true, action: null, suppressed: 'cooldown' };
  }

  const detailBase = {
    clusterId: input.clusterId,
    fromStrategy: input.strategyHash,
    rollingQuality: mean,
    minQuality: guarantee.minQuality,
    windowMin: guarantee.windowMin,
    samples: rolling.samples,
  };

  if (guarantee.action === 'alert') {
    const incidentId = await insertIncident(db, {
      orgId: input.orgId,
      kind: 'quality_breach' satisfies IncidentKind,
      detail: detailBase,
    });
    return { ...base, breach: true, action: 'alert', incidentId, suppressed: null };
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
    return { ...base, breach: true, action: 'rollback', incidentId, suppressed: null };
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
    ...base,
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
