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
import { computeSuiteContentHash, derivedSuiteIdFor } from './derived-suites.js';

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
            eq(suiteCertifications.orgId, row.orgId),
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

/**
 * The ACTIVE certification for a suite id (partial unique ⇒ at most one).
 * `orgId` is defense-in-depth: suite ids are org-partitioned by construction
 * (`agent-<orgHash6>-<slug>-replays-vN`), so a cross-org hit is not reachable
 * today — but a read that vouches for a contractual claim should not depend
 * on an id-format convention holding forever.
 */
export async function activeCertificationForSuite(
  db: PotionDb,
  suiteId: string,
  orgId: string,
): Promise<SuiteCertificationRow | null> {
  const rows = await db
    .select()
    .from(suiteCertifications)
    .where(
      and(
        eq(suiteCertifications.suiteId, suiteId),
        eq(suiteCertifications.orgId, orgId),
        eq(suiteCertifications.status, 'certified'),
      ),
    );
  return rows[0] ?? null;
}

/** Certified rows for a cluster REGARDLESS of suite generation — how the
 * gate tells "never certified" apart from "certified, then the suite moved". */
export async function certifiedRowsForCluster(
  db: PotionDb,
  clusterId: string,
  orgId: string,
): Promise<SuiteCertificationRow[]> {
  return db
    .select()
    .from(suiteCertifications)
    .where(
      and(
        eq(suiteCertifications.clusterId, clusterId),
        eq(suiteCertifications.orgId, orgId),
        eq(suiteCertifications.status, 'certified'),
      ),
    )
    .orderBy(desc(suiteCertifications.createdAt));
}

export interface ClusterCertificationState {
  certified: boolean;
  /** Set when NOT certified — the exact string surfaces on the report. */
  reason?: string;
  certification?: SuiteCertificationRow;
  /** The instrument the cluster measures on RIGHT NOW. Always populated for
   * agent clusters (success and failure alike) so a consumer can say what
   * moved without re-deriving the resolution rule — the re-derivation that
   * produced F11's disagreeing surfaces in the first place. */
  currentSuiteId: string | null;
  currentSuiteVersion: string | null;
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
  if (!clusterId.startsWith('agent-')) {
    return { certified: true, currentSuiteId: null, currentSuiteVersion: null };
  }
  const suiteId = await derivedSuiteIdFor(db, clusterId);
  const suiteRows = await db
    .select({ version: derivedSuites.version, orgId: derivedSuites.orgId })
    .from(derivedSuites)
    .where(eq(derivedSuites.suiteId, suiteId));
  const suite = suiteRows[0];
  if (!suite || suite.orgId !== orgId) {
    // F7 (owner-requested): this branch used to be reached ACCIDENTALLY when a
    // purge emptied the v2 suite — derivedSuiteIdFor falls back to v1, which
    // does not exist, so the answer was right for the wrong reason and the
    // message blamed a missing suite rather than naming what happened. Look
    // for the emptied suite and say so.
    const emptied = await db
      .select({ suiteId: derivedSuites.suiteId, version: derivedSuites.version })
      .from(derivedSuites)
      .where(and(eq(derivedSuites.clusterId, clusterId), eq(derivedSuites.orgId, orgId)));
    const priorCertified = (await certifiedRowsForCluster(db, clusterId, orgId))[0];
    if (emptied.length > 0) {
      return {
        certified: false,
        reason:
          `suite not certified — every item of '${emptied[0]!.suiteId}' has been purged ` +
          `(retention), so there is no instrument left to measure on` +
          (priorCertified ? ` — the prior certification is void; re-derive and re-certify` : ''),
        ...(priorCertified !== undefined ? { certification: priorCertified } : {}),
        currentSuiteId: suiteId,
        currentSuiteVersion: null,
      };
    }
    return {
      certified: false,
      reason: `suite not certified — no derived suite '${suiteId}' for this org`,
      currentSuiteId: suiteId,
      currentSuiteVersion: null,
    };
  }
  const current = { currentSuiteId: suiteId, currentSuiteVersion: suite.version };
  const active = await activeCertificationForSuite(db, suiteId, orgId);
  if (!active) {
    // GENERATION-AWARE (F11): a cluster that certified an EARLIER generation
    // is not the same situation as one that never certified, and the remedy
    // differs (re-certify vs certify). derivedSuiteIdFor flips to -replays-v2
    // the moment its first item lands — no version bump, no row change — so
    // this branch is where the step-level flip lands, and the old generic
    // text told the customer to run a job they had already run.
    const priorGeneration = (await certifiedRowsForCluster(db, clusterId, orgId)).find(
      (r) => r.suiteId !== suiteId,
    );
    return {
      certified: false,
      reason: priorGeneration
        ? `suite not certified — certification is for '${priorGeneration.suiteId}'@${priorGeneration.suiteVersion}, ` +
          `the cluster now measures on '${suiteId}'@${suite.version} (suite generation changed) — re-certify`
        : 'suite not certified — incumbent self-retention gate not passed (run suite:certify; ' +
          'an uncertified suite may be inspected but may not back a contractual claim)',
      ...(priorGeneration !== undefined ? { certification: priorGeneration } : {}),
      ...current,
    };
  }
  if (active.suiteVersion !== suite.version) {
    return {
      certified: false,
      reason:
        `suite not certified — certification is for suite version ${active.suiteVersion}, ` +
        `the suite is now ${suite.version} (re-derivation invalidates certification; re-certify)`,
      certification: active,
      ...current,
    };
  }
  // F7 — THE IDENTITY CHECK. The version above only ever moved when items were
  // ADDED, so it could not see a retention purge or a rubric restamp. This
  // compares what the certification vouched for against what the suite now IS.
  const liveHash = await computeSuiteContentHash(db, suiteId);
  if (active.suiteContentHash === null || active.suiteContentHash === undefined) {
    // FAIL-CLOSED. A row certified before F7 cannot demonstrate what it
    // vouched for, and an instrument that cannot prove its identity has not
    // been vouched for.
    return {
      certified: false,
      reason:
        'suite not certified — this certification predates content-hash binding and cannot ' +
        'demonstrate which instrument it vouched for (re-certify)',
      certification: active,
      ...current,
    };
  }
  if (active.suiteContentHash !== liveHash) {
    return {
      certified: false,
      reason:
        `suite not certified — the suite's CONTENT changed since certification ` +
        `(certified ${active.suiteContentHash.slice(0, 12)}…, now ${liveHash.slice(0, 12)}…): ` +
        'items were added, purged, or re-scored against a different rubric. The certification ' +
        'vouched for a different instrument — re-certify',
      certification: active,
      ...current,
    };
  }
  return { certified: true, certification: active, ...current };
}

export interface CertificationInvalidation {
  certificationId: string;
  orgId: string;
  clusterId: string;
  suiteId: string;
  certifiedHash: string | null;
  liveHash: string;
  reason: string;
}

/**
 * F7 (owner-requested): make invalidation VISIBLE rather than merely true.
 *
 * A scheduled retention purge must not silently lapse a customer's guarantee.
 * The gate already refuses a drifted certification at read time, but a refusal
 * nobody is told about is indistinguishable from an outage the customer
 * discovers themselves. This demotes drifted rows to the terminal
 * `invalidated` status and RETURNS them, so the caller can alert the org and
 * enqueue re-certification.
 *
 * `invalidated` is deliberately distinct from `superseded`: superseded means a
 * newer MEASUREMENT replaced this one; invalidated means the instrument moved
 * underneath a measurement nobody repeated. Different fact, different remedy.
 *
 * Idempotent — a row already demoted is not returned again, so repeated purges
 * do not re-alert.
 */
export async function invalidateDriftedCertifications(
  db: PotionDb,
  orgId: string,
): Promise<CertificationInvalidation[]> {
  const rows = await db
    .select()
    .from(suiteCertifications)
    .where(and(eq(suiteCertifications.orgId, orgId), eq(suiteCertifications.status, 'certified')));

  const out: CertificationInvalidation[] = [];
  for (const row of rows) {
    const liveHash = await computeSuiteContentHash(db, row.suiteId);
    if (row.suiteContentHash !== null && row.suiteContentHash === liveHash) continue;
    const reason =
      row.suiteContentHash === null
        ? 'certification predates content-hash binding; cannot demonstrate its instrument'
        : `suite content changed (certified ${row.suiteContentHash.slice(0, 12)}…, now ${liveHash.slice(0, 12)}…)`;
    await db
      .update(suiteCertifications)
      .set({ status: 'invalidated', statusReason: reason, reviewedAt: new Date() })
      .where(eq(suiteCertifications.id, row.id));
    out.push({
      certificationId: row.id,
      orgId: row.orgId,
      clusterId: row.clusterId,
      suiteId: row.suiteId,
      certifiedHash: row.suiteContentHash,
      liveHash,
      reason,
    });
  }
  return out;
}
