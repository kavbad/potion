// Proposals from the learning period: one per (org, kind of work)
// measurement. Never auto-applied — the dashboard's one button does that,
// and records which policy it created.
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { learningProposals } from '../schema.js';

export type LearningProposalRow = typeof learningProposals.$inferSelect;
export type NewLearningProposal = typeof learningProposals.$inferInsert;

export async function insertLearningProposal(db: PotionDb, row: NewLearningProposal): Promise<void> {
  await db.insert(learningProposals).values(row);
}

export async function listLearningProposals(db: PotionDb, orgId: string, limit = 50): Promise<LearningProposalRow[]> {
  return db.select().from(learningProposals).where(eq(learningProposals.orgId, orgId)).orderBy(desc(learningProposals.createdAt)).limit(limit);
}

export async function getLearningProposal(db: PotionDb, orgId: string, id: string): Promise<LearningProposalRow | null> {
  const rows = await db.select().from(learningProposals).where(and(eq(learningProposals.orgId, orgId), eq(learningProposals.id, id))).limit(1);
  return rows[0] ?? null;
}

/** The newest proposal per cluster, proposed or applied — what the page shows. */
export async function latestProposalsByCluster(db: PotionDb, orgId: string): Promise<Map<string, LearningProposalRow>> {
  const out = new Map<string, LearningProposalRow>();
  for (const r of await listLearningProposals(db, orgId, 200)) {
    if (!out.has(r.clusterId)) out.set(r.clusterId, r);
  }
  return out;
}

export async function markProposalApplied(
  db: PotionDb,
  orgId: string,
  id: string,
  policyId: string,
  /** Why it was applied when nobody clicked (the derived default); absent on a click. */
  reason?: string,
): Promise<boolean> {
  const res = await db
    .update(learningProposals)
    .set({ status: 'applied', appliedAt: new Date(), appliedPolicyId: policyId, ...(reason !== undefined ? { statusReason: reason } : {}) })
    .where(and(eq(learningProposals.orgId, orgId), eq(learningProposals.id, id), eq(learningProposals.status, 'proposed')))
    .returning({ id: learningProposals.id });
  return res.length > 0;
}

/** Platform research spend on this org's behalf since `since` (the per-org cap). */
export async function learningSpendSince(db: PotionDb, orgId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${learningProposals.spendUsd}), 0)` })
    .from(learningProposals)
    .where(and(eq(learningProposals.orgId, orgId), gte(learningProposals.createdAt, since)));
  return Number(rows[0]?.total ?? 0);
}

/** Every org's proposals in a window — the weekly run record's proposal
 * ledger (2026-09-11, observatoryRunFromLedger). Newest first. */
export async function listLearningProposalsBetween(db: PotionDb, from: Date, to: Date, limit = 500): Promise<LearningProposalRow[]> {
  return db
    .select()
    .from(learningProposals)
    .where(and(gte(learningProposals.createdAt, from), lt(learningProposals.createdAt, to)))
    .orderBy(desc(learningProposals.createdAt))
    .limit(limit);
}
