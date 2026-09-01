// W2 — the evidence-report repo. Reports are SOURCE DOCUMENTS for signals
// the durable record cannot see (downstream outcomes, reversals,
// incidents, audit verdicts). They never mutate; the graduation pass reads
// them beside the record and the two together are the evidence graph.
import { and, eq } from 'drizzle-orm';
import { labEvidenceReports, type LabEvidenceReportRow } from '../schema.js';
import type { PotionDb } from '../db.js';

export async function insertEvidenceReport(
  db: PotionDb,
  input: {
    orgId: string;
    harnessHash: string;
    runId: string;
    actionClass: string;
    actionId?: string;
    kind: LabEvidenceReportRow['kind'];
    detail?: string;
    reportedBy: string;
  },
): Promise<LabEvidenceReportRow> {
  const row = {
    id: `evr-${crypto.randomUUID().slice(0, 12)}`,
    orgId: input.orgId,
    harnessHash: input.harnessHash,
    runId: input.runId,
    actionClass: input.actionClass,
    actionId: input.actionId ?? null,
    kind: input.kind,
    detail: input.detail ?? null,
    reportedBy: input.reportedBy,
  };
  const [inserted] = await db.insert(labEvidenceReports).values(row).returning();
  return inserted!;
}

export async function listEvidenceReports(
  db: PotionDb,
  orgId: string,
  harnessHash: string,
): Promise<LabEvidenceReportRow[]> {
  return db
    .select()
    .from(labEvidenceReports)
    .where(and(eq(labEvidenceReports.orgId, orgId), eq(labEvidenceReports.harnessHash, harnessHash)))
    .orderBy(labEvidenceReports.createdAt);
}
