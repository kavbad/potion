// G1 challenger promotion proposals (migration 0085). Org-scoped by
// construction; append-only history with one-way status transitions
// (proposed → applied | dismissed).
import { and, desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  challengerProposals,
  type ChallengerProposalRow,
  type NewChallengerProposal,
} from '../schema.js';

export async function insertChallengerProposal(db: PotionDb, row: NewChallengerProposal): Promise<void> {
  await db.insert(challengerProposals).values(row);
}

export async function getChallengerProposal(
  db: PotionDb,
  orgId: string,
  id: string,
): Promise<ChallengerProposalRow | null> {
  const rows = await db
    .select()
    .from(challengerProposals)
    .where(and(eq(challengerProposals.orgId, orgId), eq(challengerProposals.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/** Newest proposal per cluster (any status) — the freshness gate reads it. */
export async function latestChallengerProposalsByCluster(
  db: PotionDb,
  orgId: string,
): Promise<Map<string, ChallengerProposalRow>> {
  const rows = await db
    .select()
    .from(challengerProposals)
    .where(eq(challengerProposals.orgId, orgId))
    .orderBy(desc(challengerProposals.createdAt));
  const out = new Map<string, ChallengerProposalRow>();
  for (const r of rows) if (!out.has(r.clusterId)) out.set(r.clusterId, r);
  return out;
}

export async function listChallengerProposals(
  db: PotionDb,
  orgId: string,
  limit = 50,
): Promise<ChallengerProposalRow[]> {
  return db
    .select()
    .from(challengerProposals)
    .where(eq(challengerProposals.orgId, orgId))
    .orderBy(desc(challengerProposals.createdAt))
    .limit(limit);
}

/** proposed → applied, stamping the minted org frontier. Returns false when
 * the row is missing or not open (the caller turns that into a 404/409). */
export async function markChallengerApplied(
  db: PotionDb,
  orgId: string,
  id: string,
  frontierId: string,
): Promise<boolean> {
  const rows = await db
    .update(challengerProposals)
    .set({ status: 'applied', appliedAt: new Date(), appliedFrontierId: frontierId })
    .where(
      and(
        eq(challengerProposals.orgId, orgId),
        eq(challengerProposals.id, id),
        eq(challengerProposals.status, 'proposed'),
      ),
    )
    .returning({ id: challengerProposals.id });
  return rows.length > 0;
}
