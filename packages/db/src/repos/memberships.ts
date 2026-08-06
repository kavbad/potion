// Thin typed repository for memberships (M2 Wave 1, ROADMAP #13): the
// (org, user) → role join — the RBAC anchor Wave-2 auth (#14) builds on.
import { and, asc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  memberships,
  type MembershipRow,
  type NewMembership,
  type Role,
} from '../schema.js';

/** Insert a membership; ON CONFLICT DO NOTHING so seeding is idempotent. */
export async function createMembership(db: PotionDb, membership: NewMembership): Promise<void> {
  await db
    .insert(memberships)
    .values(membership)
    .onConflictDoNothing({ target: [memberships.orgId, memberships.userId] });
}

/** Role lookup: the member's role in an org, or null when not a member. */
export async function getMembershipRole(
  db: PotionDb,
  orgId: string,
  userId: string,
): Promise<Role | null> {
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/** All memberships of an org (creation order). */
export async function listMembershipsByOrg(db: PotionDb, orgId: string): Promise<MembershipRow[]> {
  return db
    .select()
    .from(memberships)
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt));
}

/** All memberships of a user across orgs (creation order) — used by the
 * session-resolution path of resolveOrgContext when no org is pinned. */
export async function listMembershipsByUser(
  db: PotionDb,
  userId: string,
): Promise<MembershipRow[]> {
  return db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt));
}
