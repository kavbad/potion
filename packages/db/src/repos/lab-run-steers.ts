// X8 — the steering queue. Small and strict: bounded pending queue per run,
// org-scoped reads, consumption stamped with the model-step seq that
// carried the steer into the conversation (the receipt's join key).
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { labRunSteers, type LabRunSteerRow } from '../schema.js';
import type { PotionDb } from '../db.js';

export const STEER_LIMITS = {
  MAX_TEXT_CHARS: 2000,
  MAX_PENDING: 5,
} as const;

export type AddSteerResult = { ok: true; id: string } | { ok: false; reason: string };

export async function addLabRunSteer(
  db: PotionDb,
  input: { id: string; orgId: string; runId: string; text: string; createdBy: string },
): Promise<AddSteerResult> {
  if (input.text.trim() === '' || input.text.length > STEER_LIMITS.MAX_TEXT_CHARS) {
    return { ok: false, reason: `steering text must be 1-${STEER_LIMITS.MAX_TEXT_CHARS} chars` };
  }
  const pending = await listPendingLabRunSteers(db, input.orgId, input.runId);
  if (pending.length >= STEER_LIMITS.MAX_PENDING) {
    return { ok: false, reason: `${pending.length} steers are already waiting — the worker reads them at its next step` };
  }
  await db.insert(labRunSteers).values({
    id: input.id,
    orgId: input.orgId,
    runId: input.runId,
    text: input.text.trim(),
    createdBy: input.createdBy,
  });
  return { ok: true, id: input.id };
}

export async function listPendingLabRunSteers(
  db: PotionDb,
  orgId: string,
  runId: string,
): Promise<LabRunSteerRow[]> {
  return db
    .select()
    .from(labRunSteers)
    .where(and(eq(labRunSteers.orgId, orgId), eq(labRunSteers.runId, runId), isNull(labRunSteers.consumedAt)))
    .orderBy(asc(labRunSteers.createdAt), asc(labRunSteers.id));
}

export async function markLabRunSteersConsumed(
  db: PotionDb,
  orgId: string,
  ids: string[],
  seq: number,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(labRunSteers)
    .set({ consumedAt: new Date(), consumedSeq: seq })
    .where(and(eq(labRunSteers.orgId, orgId), inArray(labRunSteers.id, ids)));
}
