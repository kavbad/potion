// Team invites (P0-2, 2026-08-24). An invite authorizes an email for an
// org; the magic-link flow proves possession; verify converts it into the
// membership. Open = not accepted, not revoked, younger than 7 days.
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { invites, type InviteRow, type Role } from '../schema.js';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createInvite(
  db: PotionDb,
  row: { orgId: string; email: string; role: Role; invitedBy: string },
): Promise<InviteRow> {
  const inserted = await db.insert(invites).values(row).returning();
  return inserted[0]!;
}

function openCutoff(now: Date): Date {
  return new Date(now.getTime() - INVITE_TTL_MS);
}

/** The newest open invite for this email, optionally bound to one org. */
export async function openInviteForEmail(
  db: PotionDb,
  email: string,
  orgId?: string,
  now: Date = new Date(),
): Promise<InviteRow | null> {
  const rows = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.email, email),
        isNull(invites.acceptedAt),
        isNull(invites.revokedAt),
        gt(invites.createdAt, openCutoff(now)),
        ...(orgId !== undefined ? [eq(invites.orgId, orgId)] : []),
      ),
    )
    .orderBy(desc(invites.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listInvites(db: PotionDb, orgId: string): Promise<InviteRow[]> {
  return db.select().from(invites).where(eq(invites.orgId, orgId)).orderBy(desc(invites.createdAt));
}

export async function revokeInvite(db: PotionDb, orgId: string, id: string): Promise<boolean> {
  const updated = await db
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, id), eq(invites.orgId, orgId), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
    .returning();
  return updated.length > 0;
}

export async function markInviteAccepted(db: PotionDb, id: string): Promise<void> {
  await db.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, id));
}
