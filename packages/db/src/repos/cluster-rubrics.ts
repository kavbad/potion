// Cluster-rubric lifecycle repo (G1.5, migration 0022). Generated rubrics
// are drafts until a human approves; only 'approved' is IN FORCE, and the
// partial unique index guarantees at most one per cluster. Rejected and
// superseded rows stay listed forever WITH their status_reason — the owner
// rule is that customers see everything derived from their data, paired
// with status + evidence, so failures are shown, never hidden.
import { and, desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  clusterRubrics,
  judgeCalibrations,
  type ClusterRubricRow,
  type JudgeCalibrationRow,
  type NewClusterRubric,
} from '../schema.js';
import { restampDerivedSuiteRubric } from './derived-suites.js';

/** Insert a rubric row (normally status 'pending'). Returns the uuid. */
export async function insertClusterRubric(db: PotionDb, row: NewClusterRubric): Promise<string> {
  const inserted = await db.insert(clusterRubrics).values(row).returning({ id: clusterRubrics.id });
  return inserted[0]!.id;
}

export interface ClusterRubricWithEvidence {
  rubric: ClusterRubricRow;
  /** The probe-calibration record the draft was judged under; null =
   * uncalibrated (status_reason says why). */
  calibration: Pick<
    JudgeCalibrationRow,
    'id' | 'pearsonVsTruth' | 'spearmanVsTruth' | 'meanAbsErr' | 'flagged' | 'n' | 'providerMode'
  > | null;
}

/** Org-scoped list (newest first), each row paired with its calibration
 * evidence — the review surface renders BOTH, always. */
export async function listClusterRubrics(
  db: PotionDb,
  orgId: string,
): Promise<ClusterRubricWithEvidence[]> {
  const rows = await db
    .select()
    .from(clusterRubrics)
    .where(eq(clusterRubrics.orgId, orgId))
    .orderBy(desc(clusterRubrics.createdAt));
  const out: ClusterRubricWithEvidence[] = [];
  for (const rubric of rows) {
    let calibration: ClusterRubricWithEvidence['calibration'] = null;
    if (rubric.calibrationId !== null) {
      const cal = await db
        .select()
        .from(judgeCalibrations)
        .where(eq(judgeCalibrations.id, rubric.calibrationId));
      if (cal[0]) {
        const c = cal[0];
        calibration = {
          id: c.id,
          pearsonVsTruth: c.pearsonVsTruth,
          spearmanVsTruth: c.spearmanVsTruth,
          meanAbsErr: c.meanAbsErr,
          flagged: c.flagged,
          n: c.n,
          providerMode: c.providerMode,
        };
      }
    }
    out.push({ rubric, calibration });
  }
  return out;
}

/** One rubric by id, org-checked by the caller. */
export async function getClusterRubric(db: PotionDb, id: string): Promise<ClusterRubricRow | null> {
  const rows = await db.select().from(clusterRubrics).where(eq(clusterRubrics.id, id));
  return rows[0] ?? null;
}

/** The single in-force rubric for a cluster, or null. */
export async function approvedRubricForCluster(
  db: PotionDb,
  clusterId: string,
): Promise<ClusterRubricRow | null> {
  const rows = await db
    .select()
    .from(clusterRubrics)
    .where(and(eq(clusterRubrics.clusterId, clusterId), eq(clusterRubrics.status, 'approved')));
  return rows[0] ?? null;
}

/**
 * Approve a pending rubric: demote the cluster's prior approved rubric to
 * 'superseded' (reason recorded), mark this one approved, and RESTAMP the
 * suite's llm-judge items to the new text so the suite stays homogeneous.
 * One transaction — a half-approved state never exists.
 * Returns the number of restamped items.
 */
export async function approveClusterRubric(db: PotionDb, id: string): Promise<number> {
  return db.transaction(async (tx) => {
    const rubric = (await tx.select().from(clusterRubrics).where(eq(clusterRubrics.id, id)))[0];
    if (!rubric) throw new Error(`cluster rubric ${id} not found`);
    if (rubric.status !== 'pending') {
      throw new Error(`cluster rubric ${id} is '${rubric.status}', only pending can be approved`);
    }
    await tx
      .update(clusterRubrics)
      .set({
        status: 'superseded',
        statusReason: `superseded by ${rubric.id} on approval`,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(clusterRubrics.clusterId, rubric.clusterId),
          eq(clusterRubrics.status, 'approved'),
        ),
      );
    await tx
      .update(clusterRubrics)
      .set({ status: 'approved', statusReason: null, reviewedAt: new Date() })
      .where(eq(clusterRubrics.id, id));
    return restampDerivedSuiteRubric(tx as unknown as PotionDb, rubric.suiteId, rubric.rubricText);
  });
}

/** Reject a pending rubric with a required reason — the row stays listed
 * (visible rigor: "failed calibration at r=0.61 and was not deployed"). */
export async function rejectClusterRubric(
  db: PotionDb,
  id: string,
  reason: string,
): Promise<void> {
  const rubric = await getClusterRubric(db, id);
  if (!rubric) throw new Error(`cluster rubric ${id} not found`);
  if (rubric.status !== 'pending') {
    throw new Error(`cluster rubric ${id} is '${rubric.status}', only pending can be rejected`);
  }
  await db
    .update(clusterRubrics)
    .set({ status: 'rejected', statusReason: reason, reviewedAt: new Date() })
    .where(eq(clusterRubrics.id, id));
}
