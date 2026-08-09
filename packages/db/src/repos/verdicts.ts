// Durable guarantee verdicts (0029, post-G2.8).
//
// The table exists because the verdict path recorded its failures and not its
// passes: pre-0029, an all-clear with no advisory attached wrote nothing at
// all, and G2.8's contradictory 1.0645 verdict left no inputs to diagnose.
// Every suite-verify now writes exactly one row here, whatever the outcome,
// and corrections travel by SUPERSESSION (the rubric pattern) — a new row,
// with the prior kept readable under superseded_by + supersede_reason.
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  guaranteeVerdicts,
  type GuaranteeVerdictRow,
  type NewGuaranteeVerdict,
} from '../schema.js';

export async function insertGuaranteeVerdict(
  db: PotionDb,
  row: NewGuaranteeVerdict,
): Promise<string> {
  const inserted = await db
    .insert(guaranteeVerdicts)
    .values(row)
    .returning({ id: guaranteeVerdicts.id });
  return inserted[0]!.id;
}

/** The ACTIVE (non-superseded) verdict for a tuple, newest first — what the
 * guarantee report's retention headline reads. */
export async function latestVerdictForTuple(
  db: PotionDb,
  scope: { orgId: string; policyId: string; clusterId: string },
): Promise<GuaranteeVerdictRow | null> {
  const rows = await db
    .select()
    .from(guaranteeVerdicts)
    .where(
      and(
        eq(guaranteeVerdicts.orgId, scope.orgId),
        eq(guaranteeVerdicts.policyId, scope.policyId),
        eq(guaranteeVerdicts.clusterId, scope.clusterId),
        isNull(guaranteeVerdicts.supersededBy),
      ),
    )
    .orderBy(desc(guaranteeVerdicts.createdAt), desc(guaranteeVerdicts.id))
    .limit(1);
  return rows[0] ?? null;
}

/** Every verdict for an org, newest first, superseded rows INCLUDED — the
 * audit trail is the point; hiding corrected history would defeat it. */
export async function listGuaranteeVerdicts(
  db: PotionDb,
  orgId: string,
  limit = 100,
): Promise<GuaranteeVerdictRow[]> {
  return db
    .select()
    .from(guaranteeVerdicts)
    .where(eq(guaranteeVerdicts.orgId, orgId))
    .orderBy(desc(guaranteeVerdicts.createdAt), desc(guaranteeVerdicts.id))
    .limit(limit);
}

/**
 * Supersede prior verdicts with a new one — one transaction, the
 * approveClusterRubric pattern. The priors stay readable; they gain the link
 * and the reason. Refuses to supersede rows that already are (a correction of
 * a correction should chain, not overwrite the original chain), refuses
 * cross-org, and refuses a missing new row — a dangling superseded_by would
 * point the audit trail at nothing.
 */
export async function supersedeVerdict(
  db: PotionDb,
  args: { orgId: string; priorIds: string[]; newId: string; reason: string },
): Promise<number> {
  if (args.priorIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const target = (
      await tx
        .select({ id: guaranteeVerdicts.id })
        .from(guaranteeVerdicts)
        .where(
          and(eq(guaranteeVerdicts.id, args.newId), eq(guaranteeVerdicts.orgId, args.orgId)),
        )
    )[0];
    if (!target) {
      throw new Error(`supersedeVerdict: new verdict ${args.newId} not found for org ${args.orgId}`);
    }
    const updated = await tx
      .update(guaranteeVerdicts)
      .set({ supersededBy: args.newId, supersedeReason: args.reason })
      .where(
        and(
          inArray(guaranteeVerdicts.id, args.priorIds),
          eq(guaranteeVerdicts.orgId, args.orgId),
          isNull(guaranteeVerdicts.supersededBy),
        ),
      )
      .returning({ id: guaranteeVerdicts.id });
    if (updated.length !== args.priorIds.length) {
      throw new Error(
        `supersedeVerdict: expected to supersede ${args.priorIds.length} verdict(s), matched ` +
          `${updated.length} — a prior is missing, cross-org, or already superseded`,
      );
    }
    return updated.length;
  });
}
