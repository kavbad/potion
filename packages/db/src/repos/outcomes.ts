// G1 Outcome API repository (SPEC §16, migration 0083). Append-only,
// org-scoped by construction. Aggregation (latest-signal-per-request,
// Jeffreys intervals) lives in @potion/pareto's outcome-evidence module —
// this file is row shapes only.
import { and, eq, gt } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { outcomes, type NewOutcome, type OutcomeRow } from '../schema.js';

/** Insert one outcome signal. Returns the generated uuid. */
export async function insertOutcome(db: PotionDb, row: NewOutcome): Promise<string> {
  const inserted = await db.insert(outcomes).values(row).returning({ id: outcomes.id });
  return inserted[0]!.id;
}

/** Outcome rows since `since` for one org, in insertion order (id-stable) —
 * the evidence window read. */
export async function listOutcomesSince(
  db: PotionDb,
  orgId: string,
  since: Date,
): Promise<OutcomeRow[]> {
  return db
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.orgId, orgId), gt(outcomes.createdAt, since)))
    .orderBy(outcomes.createdAt, outcomes.id);
}
