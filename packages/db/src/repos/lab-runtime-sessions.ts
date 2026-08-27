// L-G4 — external runtime sessions (Lab direction v2, 2026-08-26).
//
// An external runtime instance (OpenClaw first) is a lab_run of kind
// 'external': same table, same steps, same pendingQuestion machinery, so
// every existing surface — evidence extraction, the permission ledger, the
// answer flow, org deletion — applies without a parallel universe.
//
// External runs never enter the loop's claim/fence protocol (no competing
// invocations exist), so appends here are guarded by state + cursor only.
// The payload MUST already have passed buildStepPayload's secret scan at
// the route layer — this repo trusts its caller exactly that far and no
// further (the same division appendLabStep uses).
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { labRuns, labRunSteps, type LabRunRow } from '../schema.js';

export interface ExternalSessionSpec {
  runtime: 'openclaw' | 'external';
  sessionKey: string;
  harnessHash: string;
}

/** Idempotent per (org, harness, sessionKey): the id is derived by the
 * caller from those three, so re-creates return the existing run. */
export async function ensureExternalSession(
  db: PotionDb,
  input: { id: string; orgId: string; harnessHash: string; harnessName: string; spec: ExternalSessionSpec },
): Promise<LabRunRow> {
  const existing = await db
    .select()
    .from(labRuns)
    .where(and(eq(labRuns.id, input.id), eq(labRuns.orgId, input.orgId)));
  if (existing[0]) return existing[0];
  await db.insert(labRuns).values({
    id: input.id,
    orgId: input.orgId,
    harnessHash: input.harnessHash,
    harnessName: input.harnessName,
    spec: input.spec,
    state: 'running',
  });
  return (await db.select().from(labRuns).where(eq(labRuns.id, input.id)))[0]!;
}

/** Org-scoped fetch that only returns EXTERNAL runs — the gate routes must
 * never operate on a loop-managed run. */
export async function getExternalSession(
  db: PotionDb,
  orgId: string,
  runId: string,
): Promise<LabRunRow | null> {
  const rows = await db
    .select()
    .from(labRuns)
    .where(and(eq(labRuns.id, runId), eq(labRuns.orgId, orgId)));
  const run = rows[0] ?? null;
  if (!run) return null;
  const spec = run.spec as Partial<ExternalSessionSpec> | null;
  return spec && (spec.runtime === 'openclaw' || spec.runtime === 'external') ? run : null;
}

/** Cursor-guarded append for external runs (no fence — see header). */
export async function appendExternalLabStep(
  db: PotionDb,
  input: { runId: string; orgId: string; kind: 'model' | 'tool' | 'check-in'; payload: unknown },
): Promise<number> {
  return db.transaction(async (tx) => {
    const advanced = await tx
      .update(labRuns)
      .set({ cursorSeq: sql`${labRuns.cursorSeq} + 1`, updatedAt: new Date() })
      .where(
        and(
          eq(labRuns.id, input.runId),
          eq(labRuns.orgId, input.orgId),
          inArray(labRuns.state, ['running', 'awaiting-human']),
        ),
      )
      .returning({ seq: labRuns.cursorSeq });
    if (advanced.length === 0) {
      throw new Error(`external run ${input.runId} is not accepting steps`);
    }
    const seq = advanced[0]!.seq;
    await tx.insert(labRunSteps).values({
      runId: input.runId,
      orgId: input.orgId,
      seq,
      kind: input.kind,
      payload: input.payload,
    });
    return seq;
  });
}

/** The pore opens: the run waits on a human. */
export async function holdExternalSession(
  db: PotionDb,
  orgId: string,
  runId: string,
  question: string,
): Promise<void> {
  await db
    .update(labRuns)
    .set({ state: 'awaiting-human', pendingQuestion: question, updatedAt: new Date() })
    .where(and(eq(labRuns.id, runId), eq(labRuns.orgId, orgId)));
}

/** The pore closes (any resolution): back to running, question cleared. */
export async function releaseExternalSession(
  db: PotionDb,
  orgId: string,
  runId: string,
): Promise<void> {
  await db
    .update(labRuns)
    .set({ state: 'running', pendingQuestion: null, pendingAnswer: null, updatedAt: new Date() })
    .where(and(eq(labRuns.id, runId), eq(labRuns.orgId, orgId)));
}
