// L-G2 — the graduation pass (Lab direction v2, 2026-08-26): supervision
// traffic in, standing decisions out. Composes the pure pieces:
//
//   listLabStepsForHarness → extractPoreEvidence → graduationDecision
//
// and applies THE ASYMMETRY: 'tighten' is written immediately (fail
// closed); 'propose-graduate' is only RETURNED — nothing here, or anywhere,
// grants autonomy without acceptGraduation's human-accept path.
import {
  ensureActionGrant,
  listActionGrants,
  listEvidenceReports,
  listLabStepsForHarness,
  setGrantSituations,
  tightenGrant,
  type PotionDb,
} from '@potion/db';
import type { StepPayload } from './checkpoint.js';
import { demonstratedSituations, evidenceFromReports, extractPoreEvidence, mergeEvidence, tierFor, type EvidenceStep } from './evidence.js';
import { graduationDecision, type GraduationDecision, type RiskTier } from './graduation.js';

export interface GraduationPassResult {
  /** Classes whose grants were re-supervised this pass, with the reason. */
  tightened: Array<{ actionClass: string; why: string }>;
  /** Classes ready for the human-accept path — proposals, never grants. */
  proposals: Array<{ grantId: string; actionClass: string; decision: Extract<GraduationDecision, { kind: 'propose-graduate' }> }>;
  /** Everything evaluated, for the ledger surface. */
  evaluated: Array<{ actionClass: string; state: string; decision: GraduationDecision['kind']; why: string }>;
}

export async function runGraduationPass(opts: {
  db: PotionDb;
  orgId: string;
  harnessHash: string;
  /** act/read classification per tool from the superpower catalog. */
  classify: (actionClass: string) => 'read' | 'act' | undefined;
  /** Spec-level tier overrides (the spec sets the leash at birth). */
  tierOverrides?: Readonly<Record<string, RiskTier>>;
  now?: Date;
}): Promise<GraduationPassResult> {
  const now = opts.now ?? new Date();
  const rows = await listLabStepsForHarness(opts.db, opts.orgId, opts.harnessHash);
  const steps: EvidenceStep[] = rows.map((r) => ({ payload: r.payload as StepPayload, createdAt: r.createdAt }));
  // W2 — two evidence sources, one stream per class: the durable record
  // (pore answers + gate-allowed executions) and the report table (signals
  // born outside the record: outcomes, reversals, incidents, audit
  // verdicts). Merged in time order.
  const reports = await listEvidenceReports(opts.db, opts.orgId, opts.harnessHash);
  const byClass = mergeEvidence(
    extractPoreEvidence(steps),
    evidenceFromReports(reports.map((r) => ({ actionClass: r.actionClass, kind: r.kind, createdAt: r.createdAt }))),
  );

  const result: GraduationPassResult = { tightened: [], proposals: [], evaluated: [] };
  const existing = new Map((await listActionGrants(opts.db, opts.orgId, opts.harnessHash)).map((g) => [g.actionClass, g]));

  for (const [actionClass, evidence] of byClass) {
    const tier = existing.get(actionClass)?.riskTier ??
      tierFor(actionClass, opts.classify(actionClass), opts.tierOverrides);
    const grant =
      existing.get(actionClass) ??
      (await ensureActionGrant(opts.db, { orgId: opts.orgId, harnessHash: opts.harnessHash, actionClass, riskTier: tier }));

    const decision = graduationDecision({ tier: grant.riskTier, state: grant.state, evidence, now });
    result.evaluated.push({ actionClass, state: grant.state, decision: decision.kind, why: decision.why });

    if (decision.kind === 'tighten') {
      await tightenGrant(opts.db, grant.id, decision.why);
      result.tightened.push({ actionClass, why: decision.why });
    } else if (decision.kind === 'propose-graduate' && grant.state === 'supervised') {
      result.proposals.push({ grantId: grant.id, actionClass, decision });
    }

    // W2 — materialize the demonstrated-situation view (a re-derivation
    // from the evidence, never an edit); the gateway holds autonomous
    // actions outside it.
    const sigs = demonstratedSituations(evidence);
    const existingSigs = (grant as { situations?: string[] }).situations ?? [];
    if (JSON.stringify(sigs) !== JSON.stringify(existingSigs)) {
      await setGrantSituations(opts.db, grant.id, sigs);
    }
  }
  return result;
}
