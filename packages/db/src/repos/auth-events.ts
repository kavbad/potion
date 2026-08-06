// Auth-event trail repository (M4, ROADMAP #34, SPEC §13.6, migration 0012).
// Append-only: every login/logout/invite (magic-link AND OIDC) writes a row.
// Reads are org-scoped; there is deliberately NO update/delete.
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { authEvents, type AuthEventRow, type NewAuthEvent } from '../schema.js';

/** Append an auth event. detail must NEVER contain credentials or tokens. */
export async function insertAuthEvent(db: PotionDb, row: NewAuthEvent): Promise<void> {
  await db.insert(authEvents).values(row);
}

/** Org-scoped recent auth events, newest first (dashboard view). */
export async function listAuthEvents(
  db: PotionDb,
  orgId: string,
  limit = 100,
): Promise<AuthEventRow[]> {
  return db
    .select()
    .from(authEvents)
    .where(eq(authEvents.orgId, orgId))
    .orderBy(desc(authEvents.createdAt))
    .limit(limit);
}

/**
 * Org-scoped auth events inside [from, to], OLDEST first, chunked for the
 * streaming audit export (pass offset += rows.length until a short page).
 */
export async function listAuthEventsRange(
  db: PotionDb,
  orgId: string,
  from: Date,
  to: Date,
  limit: number,
  offset: number,
): Promise<AuthEventRow[]> {
  return db
    .select()
    .from(authEvents)
    .where(
      and(
        eq(authEvents.orgId, orgId),
        gte(authEvents.createdAt, from),
        lte(authEvents.createdAt, to),
      ),
    )
    .orderBy(asc(authEvents.createdAt), asc(authEvents.id))
    .limit(limit)
    .offset(offset);
}
