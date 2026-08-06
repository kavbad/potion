// Thin typed repository for request_logs (SPEC §7/§8; ORG-SCOPED since M2
// Wave 1 / ROADMAP #13). Rows carry org_id NOT NULL — including
// unauthenticated traffic, which the server attributes to the default org.
import { desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { requestLogs, type NewRequestLog, type RequestLogRow } from '../schema.js';

/** Insert a request-log row (row.orgId is required by the schema). */
export async function insertRequestLog(db: PotionDb, log: NewRequestLog): Promise<bigint> {
  const rows = await db.insert(requestLogs).values(log).returning({ id: requestLogs.id });
  const row = rows[0];
  if (!row) throw new Error('insertRequestLog: no id returned');
  return row.id;
}

export async function listRequestLogs(
  db: PotionDb,
  orgId: string,
  limit = 100,
): Promise<RequestLogRow[]> {
  return db
    .select()
    .from(requestLogs)
    .where(eq(requestLogs.orgId, orgId))
    .orderBy(desc(requestLogs.id))
    .limit(limit);
}
