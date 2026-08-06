// Custody audit trail repository (M2 Wave 2, ROADMAP #16, migration 0005).
// Append-only: every custody event (encrypt/decrypt/rotate/revoke/validate)
// writes a row. Reads are org-scoped; there is deliberately NO update/delete.
import { and, desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { custodyAudit, type CustodyAuditRow, type NewCustodyAudit } from '../schema.js';

/** Append a custody event. metadata must NEVER contain key material. */
export async function insertCustodyAudit(db: PotionDb, row: NewCustodyAudit): Promise<void> {
  await db.insert(custodyAudit).values(row);
}

/** Org-scoped audit listing, newest first; optionally pinned to one key. */
export async function listCustodyAudit(
  db: PotionDb,
  orgId: string,
  providerKeyId?: string,
  limit = 100,
): Promise<CustodyAuditRow[]> {
  const where = providerKeyId
    ? and(eq(custodyAudit.orgId, orgId), eq(custodyAudit.providerKeyId, providerKeyId))
    : eq(custodyAudit.orgId, orgId);
  return db.select().from(custodyAudit).where(where).orderBy(desc(custodyAudit.createdAt)).limit(limit);
}
