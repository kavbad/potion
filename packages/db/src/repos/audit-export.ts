// Audit-export range readers (M4, ROADMAP #34, SPEC §13.6) — org-scoped,
// chunked, OLDEST-first reads over the three event sources that make up the
// unified audit export (/api/audit/export.jsonl):
//   custody_audit (0005, key lifecycle) · auth_events (0012, auth trail) ·
//   incidents (0008, guarantee quality_breach/rollback).
// The server route merges the three streams by created_at; chunking
// (limit/offset) keeps the export STREAMED, never fully buffered.
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  custodyAudit,
  incidents,
  type CustodyAuditRow,
  type IncidentRow,
} from '../schema.js';

export const AUDIT_EXPORT_CHUNK = 1000;

/** custody_audit rows in [from, to] for the org, oldest first (chunked). */
export async function listCustodyAuditRange(
  db: PotionDb,
  orgId: string,
  from: Date,
  to: Date,
  limit: number,
  offset: number,
): Promise<CustodyAuditRow[]> {
  return db
    .select()
    .from(custodyAudit)
    .where(
      and(
        eq(custodyAudit.orgId, orgId),
        gte(custodyAudit.createdAt, from),
        lte(custodyAudit.createdAt, to),
      ),
    )
    .orderBy(asc(custodyAudit.createdAt), asc(custodyAudit.id))
    .limit(limit)
    .offset(offset);
}

/** The org's most recent incidents, newest first (dashboard audit view). */
export async function listIncidentsRecent(
  db: PotionDb,
  orgId: string,
  limit: number,
): Promise<IncidentRow[]> {
  return db
    .select()
    .from(incidents)
    .where(eq(incidents.orgId, orgId))
    .orderBy(desc(incidents.createdAt))
    .limit(limit);
}

/** incidents rows in [from, to] for the org, oldest first (chunked). */
export async function listIncidentsRange(
  db: PotionDb,
  orgId: string,
  from: Date,
  to: Date,
  limit: number,
  offset: number,
): Promise<IncidentRow[]> {
  return db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.orgId, orgId),
        gte(incidents.createdAt, from),
        lte(incidents.createdAt, to),
      ),
    )
    .orderBy(asc(incidents.createdAt), asc(incidents.id))
    .limit(limit)
    .offset(offset);
}
