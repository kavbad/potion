// Thin typed repository for users (M2 Wave 1, ROADMAP #13). Users are global
// identities (email-unique); tenancy is conferred via memberships.
import { eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { users, type NewUser, type UserRow } from '../schema.js';

/** Insert a user; ON CONFLICT DO NOTHING so seeding is idempotent. */
export async function createUser(db: PotionDb, user: NewUser): Promise<void> {
  await db.insert(users).values(user).onConflictDoNothing({ target: users.id });
}

export async function getUserById(db: PotionDb, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByEmail(db: PotionDb, email: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}
