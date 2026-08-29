// P1 (the clock) — the armed-mission repo. Arming is an explicit admin act
// binding ONE harness version; the scheduler reads armed rows platform-wide
// and dedups by window key (at most one check per cadence window). Pausing
// never deletes: the row keeps its history (last window, last note).
import { and, eq, gte } from 'drizzle-orm';
import { labMissions, labRuns, labRunSteps, type LabMissionRow } from '../schema.js';
import type { PotionDb } from '../db.js';

export async function armLabMission(
  db: PotionDb,
  input: { orgId: string; harnessHash: string; cadenceCron: string; armedBy: string; hookTokenHash?: string | null },
): Promise<void> {
  await db
    .insert(labMissions)
    .values({
      orgId: input.orgId,
      harnessHash: input.harnessHash,
      state: 'armed',
      cadenceCron: input.cadenceCron,
      armedBy: input.armedBy,
      armedAt: new Date(),
      updatedAt: new Date(),
      ...(input.hookTokenHash !== undefined ? { hookTokenHash: input.hookTokenHash } : {}),
    })
    .onConflictDoUpdate({
      target: [labMissions.orgId, labMissions.harnessHash],
      set: {
        state: 'armed',
        cadenceCron: input.cadenceCron,
        armedBy: input.armedBy,
        armedAt: new Date(),
        updatedAt: new Date(),
        ...(input.hookTokenHash !== undefined ? { hookTokenHash: input.hookTokenHash } : {}),
      },
    });
}

/** P5: the webhook inlet's lookup — token hash → the ARMED mission it
 * wakes. Hash-addressed (the plaintext never lands anywhere); a paused
 * mission is deliberately unfindable, so pausing also closes the inlet. */
export async function findArmedMissionByHookHash(
  db: PotionDb,
  hookTokenHash: string,
): Promise<LabMissionRow | null> {
  const rows = await db
    .select()
    .from(labMissions)
    .where(and(eq(labMissions.hookTokenHash, hookTokenHash), eq(labMissions.state, 'armed')))
    .limit(1);
  return rows[0] ?? null;
}

/** P5: persist the scheduler's per-url feed observation stamps. */
export async function setMissionFeedState(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  feedState: Record<string, { hash: string; checkedAt: string; firedAt?: string }>,
): Promise<void> {
  await db
    .update(labMissions)
    .set({ feedState, updatedAt: new Date() })
    .where(and(eq(labMissions.orgId, orgId), eq(labMissions.harnessHash, harnessHash)));
}

export async function pauseLabMission(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<boolean> {
  const rows = await db
    .update(labMissions)
    .set({ state: 'paused', updatedAt: new Date() })
    .where(and(eq(labMissions.orgId, orgId), eq(labMissions.harnessHash, harnessHash)))
    .returning({ x: labMissions.harnessHash });
  return rows.length > 0;
}

export async function getLabMission(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<LabMissionRow | null> {
  const rows = await db
    .select()
    .from(labMissions)
    .where(and(eq(labMissions.orgId, orgId), eq(labMissions.harnessHash, harnessHash)))
    .limit(1);
  return rows[0] ?? null;
}

/** Platform-wide: every armed mission (the scheduler's worklist). */
export async function listArmedMissions(db: PotionDb): Promise<LabMissionRow[]> {
  return db.select().from(labMissions).where(eq(labMissions.state, 'armed'));
}

/** Record that a window was handled (check started, or skipped with a
 * note) — the dedup that makes "at most one check per window" true. */
export async function recordMissionWindow(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  windowKey: string,
  note: string | null,
): Promise<void> {
  await db
    .update(labMissions)
    .set({ lastWindowKey: windowKey, lastNote: note, updatedAt: new Date() })
    .where(and(eq(labMissions.orgId, orgId), eq(labMissions.harnessHash, harnessHash)));
}

/** Estimated spend for a harness since an instant — the scheduler's
 * day-budget refusal basis. Estimates, deliberately: metered truth lags
 * the request-log join, and a budget gate must err conservative. Bounded
 * work: one day of one harness's model steps. */
export async function sumLabRunEstSince(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ payload: labRunSteps.payload })
    .from(labRunSteps)
    .innerJoin(labRuns, eq(labRunSteps.runId, labRuns.id))
    .where(
      and(
        eq(labRuns.orgId, orgId),
        eq(labRuns.harnessHash, harnessHash),
        eq(labRunSteps.kind, 'model'),
        gte(labRunSteps.createdAt, since),
      ),
    );
  let total = 0;
  for (const r of rows) {
    const est = (r.payload as { estCostUsd?: number }).estCostUsd;
    if (typeof est === 'number' && Number.isFinite(est)) total += est;
  }
  return total;
}
