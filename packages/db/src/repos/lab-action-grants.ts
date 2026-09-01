// L-G2 — the trust-record repo (Lab direction v2, 2026-08-26). Distinct
// from repos/lab-grants.ts (Step 10 MCP *credential* grants): this file is
// the per-(harness, action class) PERMISSION record.
//
// The write asymmetry lives HERE, as the shape of the API:
//   · tightenGrant  — no ceremony: any caller with a reason re-supervises.
//   · acceptGraduation — the ONLY path to 'autonomous', and it hard-floors
//     the audit rate. There is no setState; loosening without a proposal is
//     not expressible.
import { and, eq } from 'drizzle-orm';
import {
  labActionGrants,
  labRuns,
  labRunSteps,
  type LabActionGrantRow,
  type LabGrantState,
  type LabRiskTier,
} from '../schema.js';
import type { PotionDb } from '../db.js';

/** Audit floor duplicated from @potion/lab-runtime graduation.ts (db must
 * not depend on lab-runtime); a cross-package divergence test pins them. */
export const GRANT_AUDIT_RATE_FLOOR = 0.05;

export async function listActionGrants(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<LabActionGrantRow[]> {
  return db
    .select()
    .from(labActionGrants)
    .where(and(eq(labActionGrants.orgId, orgId), eq(labActionGrants.harnessHash, harnessHash)))
    .orderBy(labActionGrants.actionClass);
}

/** W1 — the gateway's act-time read: ONE class, FRESH, every action.
 * No caching layer may wrap this; a tighten written anywhere must bite
 * the very next action everywhere. */
export async function getActionGrantByClass(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
  actionClass: string,
): Promise<LabActionGrantRow | null> {
  const rows = await db
    .select()
    .from(labActionGrants)
    .where(
      and(
        eq(labActionGrants.orgId, orgId),
        eq(labActionGrants.harnessHash, harnessHash),
        eq(labActionGrants.actionClass, actionClass),
      ),
    );
  return rows[0] ?? null;
}

/** Idemptent birth: every observed action class gets a supervised row. */
export async function ensureActionGrant(
  db: PotionDb,
  input: { orgId: string; harnessHash: string; actionClass: string; riskTier: LabRiskTier },
): Promise<LabActionGrantRow> {
  const existing = await db
    .select()
    .from(labActionGrants)
    .where(
      and(
        eq(labActionGrants.orgId, input.orgId),
        eq(labActionGrants.harnessHash, input.harnessHash),
        eq(labActionGrants.actionClass, input.actionClass),
      ),
    );
  if (existing[0]) return existing[0];
  const row = {
    id: `lag-${crypto.randomUUID().slice(0, 12)}`,
    orgId: input.orgId,
    harnessHash: input.harnessHash,
    actionClass: input.actionClass,
    riskTier: input.riskTier,
    state: 'supervised' as LabGrantState,
    auditRate: 1,
  };
  await db.insert(labActionGrants).values(row);
  return (await db.select().from(labActionGrants).where(eq(labActionGrants.id, row.id)))[0]!;
}

/** Automatic re-supervision — fail closed, no human in the loop. */
export async function tightenGrant(
  db: PotionDb,
  grantId: string,
  reason: string,
): Promise<void> {
  await db
    .update(labActionGrants)
    .set({
      state: 'supervised',
      auditRate: 1,
      stateReason: reason,
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(labActionGrants.id, grantId));
}

/**
 * The human-accept path — the ONLY way a grant becomes autonomous, and the
 * caller cannot escape the audit floor. 'never-graduates' rows refuse here
 * too: defense in depth under the evaluator's refusal.
 */
export async function acceptGraduation(
  db: PotionDb,
  grantId: string,
  opts: { auditRate?: number } = {},
): Promise<LabActionGrantRow> {
  const row = (await db.select().from(labActionGrants).where(eq(labActionGrants.id, grantId)))[0];
  if (!row) throw new Error(`no such action grant: ${grantId}`);
  if (row.riskTier === 'never-graduates') {
    throw new Error(`action class '${row.actionClass}' never graduates by design`);
  }
  const auditRate = Math.max(GRANT_AUDIT_RATE_FLOOR, Math.min(1, opts.auditRate ?? GRANT_AUDIT_RATE_FLOOR));
  await db
    .update(labActionGrants)
    .set({
      state: 'autonomous',
      auditRate,
      stateReason: null,
      grantedAt: new Date(),
      revokedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(labActionGrants.id, grantId));
  return (await db.select().from(labActionGrants).where(eq(labActionGrants.id, grantId)))[0]!;
}

/** Org-scoped single-grant fetch — the accept route's tenancy guard. */
export async function getActionGrant(
  db: PotionDb,
  orgId: string,
  grantId: string,
): Promise<LabActionGrantRow | null> {
  const rows = await db
    .select()
    .from(labActionGrants)
    .where(and(eq(labActionGrants.id, grantId), eq(labActionGrants.orgId, orgId)));
  return rows[0] ?? null;
}

/** Every step for a harness across ALL its runs, in run/seq order — the
 * evidence source for graduation (L-G2). */
export async function listLabStepsForHarness(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<Array<{ runId: string; seq: number; kind: string; payload: unknown; createdAt: Date }>> {
  return db
    .select({
      runId: labRunSteps.runId,
      seq: labRunSteps.seq,
      kind: labRunSteps.kind,
      payload: labRunSteps.payload,
      createdAt: labRunSteps.createdAt,
    })
    .from(labRunSteps)
    .innerJoin(labRuns, eq(labRunSteps.runId, labRuns.id))
    // W3: shadow runs are proof material, never evidence — a candidate's
    // rehearsal must not buy or cost trust.
    .where(and(eq(labRunSteps.orgId, orgId), eq(labRuns.harnessHash, harnessHash), eq(labRuns.shadow, false)))
    .orderBy(labRuns.createdAt, labRunSteps.seq);
}

/** W2 — materialize the demonstrated-situation view onto the grant row.
 * Called only by the graduation pass; the value is always a re-derivation
 * from records, never an edit. */
export async function setGrantSituations(
  db: PotionDb,
  grantId: string,
  situations: string[],
): Promise<void> {
  await db.update(labActionGrants).set({ situations }).where(eq(labActionGrants.id, grantId));
}

/** W3 — promotion writes an INHERITED autonomous state onto a descendant's
 * grant row. This is not a loosening path a model can reach: it runs only
 * inside the human-initiated promote route, carrying state a human already
 * granted on the parent, restricted by the inheritance plan. */
export async function inheritGrantState(
  db: PotionDb,
  grantId: string,
  input: { state: 'autonomous'; auditRate: number; situations: string[]; grantedAt: Date | null; reason: string },
): Promise<void> {
  await db
    .update(labActionGrants)
    .set({
      state: input.state,
      auditRate: Math.max(input.auditRate, GRANT_AUDIT_RATE_FLOOR),
      situations: input.situations,
      grantedAt: input.grantedAt ?? new Date(),
      stateReason: input.reason,
    })
    .where(eq(labActionGrants.id, grantId));
}
