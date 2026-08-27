// R1 (Router direction, 2026-08-27) — the router-version ledger. Versions
// are MINTED, never updated: appendRouterVersion inserts the next number
// for the org and races resolve through the unique (org_id, version)
// constraint — the loser re-reads and, if the winner minted the SAME hash,
// returns it instead of double-minting.
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { routerVersions, type RouterVersionRow } from '../schema.js';
import type { PotionDb } from '../db.js';

export async function latestRouterVersion(db: PotionDb, orgId: string): Promise<RouterVersionRow | null> {
  const rows = await db
    .select()
    .from(routerVersions)
    .where(eq(routerVersions.orgId, orgId))
    .orderBy(desc(routerVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listRouterVersions(db: PotionDb, orgId: string, limit = 20): Promise<RouterVersionRow[]> {
  return db
    .select()
    .from(routerVersions)
    .where(eq(routerVersions.orgId, orgId))
    .orderBy(desc(routerVersions.version))
    .limit(limit);
}

/** Append the next version for the org. Concurrency-safe: a unique-conflict
 * loser re-reads the latest row and returns it when the winner minted the
 * same hash (the common race: two dashboard tabs); a DIFFERENT hash retries
 * once with the next number. */
export async function appendRouterVersion(
  db: PotionDb,
  opts: { orgId: string; routerHash: string; document: unknown },
): Promise<RouterVersionRow> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await latestRouterVersion(db, opts.orgId);
    if (latest !== null && latest.routerHash === opts.routerHash) return latest;
    const version = (latest?.version ?? 0) + 1;
    try {
      const rows = await db
        .insert(routerVersions)
        .values({
          id: `rv-${randomUUID()}`,
          orgId: opts.orgId,
          version,
          routerHash: opts.routerHash,
          document: opts.document,
        })
        .returning();
      return rows[0]!;
    } catch {
      // unique (org_id, version) conflict — loop re-reads and re-decides.
    }
  }
  const latest = await latestRouterVersion(db, opts.orgId);
  if (latest !== null) return latest;
  throw new Error('appendRouterVersion: could not mint a version');
}
