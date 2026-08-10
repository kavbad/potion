// Suite-certification lifecycle repo (post-capstone item 3, migration 0031).
// Decision 2's gate: a derived suite is certified for guarantee use only if
// the incumbent retains its own baseline when fresh-re-evaluated against it.
// Mirrors the cluster-rubrics lifecycle (0022): the partial unique index
// makes "the active certification for a suite" a total function; supersede-
// don't-mutate; failed and refused rows stay listed forever WITH their
// status_reason — customers see everything derived from their data, paired
// with status + evidence, never hidden.
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import {
  derivedSuites,
  suiteCertifications,
  type NewSuiteCertification,
  type SuiteCertificationRow,
} from '../schema.js';
import { derivedSuiteIdFor } from './derived-suites.js';

/**
 * Insert a certification outcome, superseding any prior ACTIVE ('certified')
 * row for the suite in the same transaction — the approveClusterRubric
 * demote-then-promote shape, so the partial unique index is never violated
 * mid-flight. A new MEASUREMENT supersedes the prior pass in either
 * direction: a fresh FAILED measurement revokes a stale certification — a
 * certified badge that survives failed re-measurement would be the exact
 * dishonesty this table exists to prevent. REFUSALS (evidence.refused ===
 * true: budget, mode-mismatch, no-incumbent, no-suite) are recorded history
 * but demote nothing — a refusal is the absence of a measurement, not
 * evidence against the suite. Returns the new id.
 */
export async function insertSuiteCertificationTx(
  db: PotionDb,
  row: NewSuiteCertification,
): Promise<string> {
  // Client-generated id so the DEMOTE (which must run FIRST — inserting a
  // second 'certified' row would violate the partial unique index before any
  // demote could run) can name its successor, the approveClusterRubric rule.
  const newId = row.id ?? randomUUID();
  const isRefusal = (row.evidence as { refused?: unknown } | null | undefined)?.refused === true;
  return db.transaction(async (tx) => {
    if (!isRefusal) {
      await tx
        .update(suiteCertifications)
        .set({
          status: 'superseded',
          statusReason: `superseded by ${newId} (re-certification)`,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(suiteCertifications.suiteId, row.suiteId),
            eq(suiteCertifications.status, 'certified'),
          ),
        );
    }
    await tx.insert(suiteCertifications).values({ ...row, id: newId });
    return newId;
  });
}

/** Org-scoped list, newest first — the review surface renders every row
 * with its status + evidence. */
export async function listSuiteCertifications(
  db: PotionDb,
  orgId: string,
): Promise<SuiteCertificationRow[]> {
  return db
    .select()
    .from(suiteCertifications)
    .where(eq(suiteCertifications.orgId, orgId))
    .orderBy(desc(suiteCertifications.createdAt));
}

/** The ACTIVE certification for a suite id (partial unique ⇒ at most one). */
export async function activeCertificationForSuite(
  db: PotionDb,
  suiteId: string,
): Promise<SuiteCertificationRow | null> {
  const rows = await db
    .select()
    .from(suiteCertifications)
    .where(
      and(eq(suiteCertifications.suiteId, suiteId), eq(suiteCertifications.status, 'certified')),
    );
  return rows[0] ?? null;
}

export interface ClusterCertificationState {
  certified: boolean;
  /** Set when NOT certified — the exact string surfaces on the report. */
  reason?: string;
  certification?: SuiteCertificationRow;
}

/**
 * THE gating predicate every surface calls (report headline, savings
 * withholding, suite-verify contractual effects). Resolves the cluster's
 * CURRENT suite (v2-preferred via derivedSuiteIdFor), loads its version, and
 * requires an active 'certified' row for that exact (suite, version) —
 * re-derivation bumps the version and invalidates certification by key.
 *
 * Non-agent clusters return certified: true — certification is a property
 * of DERIVED agentic suites (whole-session replay proved invalid there);
 * authored taxonomy suites are outside its scope.
 */
export async function certificationStateForCluster(
  db: PotionDb,
  clusterId: string,
  orgId: string,
): Promise<ClusterCertificationState> {
  if (!clusterId.startsWith('agent-')) return { certified: true };
  const suiteId = await derivedSuiteIdFor(db, clusterId);
  const suiteRows = await db
    .select({ version: derivedSuites.version, orgId: derivedSuites.orgId })
    .from(derivedSuites)
    .where(eq(derivedSuites.suiteId, suiteId));
  const suite = suiteRows[0];
  if (!suite || suite.orgId !== orgId) {
    return {
      certified: false,
      reason: `suite not certified — no derived suite '${suiteId}' for this org`,
    };
  }
  const active = await activeCertificationForSuite(db, suiteId);
  if (!active || active.orgId !== orgId) {
    return {
      certified: false,
      reason:
        'suite not certified — incumbent self-retention gate not passed (run suite:certify; ' +
        'an uncertified suite may be inspected but may not back a contractual claim)',
    };
  }
  if (active.suiteVersion !== suite.version) {
    return {
      certified: false,
      reason:
        `suite not certified — certification is for suite version ${active.suiteVersion}, ` +
        `the suite is now ${suite.version} (re-derivation invalidates certification; re-certify)`,
      certification: active,
    };
  }
  return { certified: true, certification: active };
}
