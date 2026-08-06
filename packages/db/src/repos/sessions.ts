// Thin typed repository for sessions + magic links (M2 Wave 2, ROADMAP #14).
//
// Token hygiene: raw tokens (`ps_…` sessions, `ml_…` magic links) are NEVER
// stored — callers pass sha256(rawToken) as tokenHash (see
// apps/server/src/routes/auth.ts). Sessions are looked up by token_hash and
// must be unexpired + unrevoked; magic links are consumed atomically
// (single-use) and must be unexpired.
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  magicLinks,
  sessions,
  type MagicLinkRow,
  type NewMagicLink,
  type NewSession,
  type SessionRow,
} from '../schema.js';

/** Insert a session row; returns it. */
export async function createSession(db: PotionDb, session: NewSession): Promise<SessionRow> {
  const rows = await db.insert(sessions).values(session).returning();
  return rows[0]!;
}

/** Live-session lookup by token hash: unexpired AND unrevoked, else null. */
export async function findSessionByTokenHash(
  db: PotionDb,
  tokenHash: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getSessionById(db: PotionDb, id: string): Promise<SessionRow | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Revoke a session (logout). Idempotent: re-revoking keeps the first
 * revoked_at. Returns the revoked row, or null when unknown. */
export async function revokeSession(db: PotionDb, id: string): Promise<SessionRow | null> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: sql`coalesce(${sessions.revokedAt}, now())` })
    .where(eq(sessions.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Insert a magic-link row (token_hash is the pk). */
export async function createMagicLink(db: PotionDb, link: NewMagicLink): Promise<MagicLinkRow> {
  const rows = await db.insert(magicLinks).values(link).returning();
  return rows[0]!;
}

export async function getMagicLinkByTokenHash(
  db: PotionDb,
  tokenHash: string,
): Promise<MagicLinkRow | null> {
  const rows = await db
    .select()
    .from(magicLinks)
    .where(eq(magicLinks.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Single-use consume: atomically marks the link consumed ONLY when it is
 * unconsumed and unexpired, returning the row; null otherwise (unknown,
 * already consumed, or expired). The conditional UPDATE … RETURNING makes
 * concurrent double-spend impossible (one row, one winner). */
export async function consumeMagicLink(db: PotionDb, tokenHash: string): Promise<MagicLinkRow | null> {
  const rows = await db
    .update(magicLinks)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(magicLinks.tokenHash, tokenHash),
        isNull(magicLinks.consumedAt),
        sql`${magicLinks.expiresAt} > now()`,
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Housekeeping: delete expired/revoked sessions and expired-or-consumed
 * magic links. Returns the per-table delete counts. Safe to run any time
 * (boot, cron); live rows are never touched. */
export async function purgeExpired(db: PotionDb): Promise<{ sessions: number; magicLinks: number }> {
  const deadSessions = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, sql`now()`), sql`${sessions.revokedAt} IS NOT NULL`))
    .returning({ id: sessions.id });
  const deadLinks = await db
    .delete(magicLinks)
    .where(
      or(lt(magicLinks.expiresAt, sql`now()`), sql`${magicLinks.consumedAt} IS NOT NULL`),
    )
    .returning({ tokenHash: magicLinks.tokenHash });
  return { sessions: deadSessions.length, magicLinks: deadLinks.length };
}
