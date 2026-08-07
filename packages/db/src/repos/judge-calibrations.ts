// Judge-calibration evidence repo (G0.2, migration 0018). Thin typed CRUD —
// the calibration MATH lives in @potion/harness calibrate.ts; this table is
// the auditable record the guarantee surfaces (GET /api/guarantee/status)
// and future serving gates read.
import { and, desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  judgeCalibrations,
  type JudgeCalibrationRow,
  type NewJudgeCalibration,
} from '../schema.js';

/** Insert one calibration record. Returns the generated uuid. */
export async function insertJudgeCalibration(
  db: PotionDb,
  row: NewJudgeCalibration,
): Promise<string> {
  const inserted = await db.insert(judgeCalibrations).values(row).returning({ id: judgeCalibrations.id });
  return inserted[0]!.id;
}

/**
 * The most recent calibration record for a judge ALIAS, optionally narrowed
 * by provider mode (a guarantee serving live must not present a mock
 * calibration as its trust evidence) and cluster.
 */
export async function latestJudgeCalibration(
  db: PotionDb,
  scope: { judgeModel: string; providerMode?: string; clusterId?: string },
): Promise<JudgeCalibrationRow | null> {
  const rows = await db
    .select()
    .from(judgeCalibrations)
    .where(
      and(
        eq(judgeCalibrations.judgeModel, scope.judgeModel),
        scope.providerMode !== undefined
          ? eq(judgeCalibrations.providerMode, scope.providerMode)
          : undefined,
        scope.clusterId !== undefined
          ? eq(judgeCalibrations.clusterId, scope.clusterId)
          : undefined,
      ),
    )
    .orderBy(desc(judgeCalibrations.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** All calibration records (newest first) — reporting/tests. */
export async function listJudgeCalibrations(
  db: PotionDb,
  limit = 100,
): Promise<JudgeCalibrationRow[]> {
  return db
    .select()
    .from(judgeCalibrations)
    .orderBy(desc(judgeCalibrations.createdAt))
    .limit(limit);
}
