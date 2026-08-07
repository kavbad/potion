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
  /** Why no incident was written (null = an incident was written).
   * 'not-significant' (G0.3): observed mean below the floor but the CI95
   * straddles it — the at-risk state; visible, never an incident. */
  suppressed: 'insufficient-evidence' | 'no-breach' | 'not-significant' | 'cooldown' | null;
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
    incidentId: null,
    ci95: null,
    seed: null,
    minSamplesRequired: minSamples,
    rollback: null,
  };
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
