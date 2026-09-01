// L-G2 — evidence extraction (Lab direction v2, 2026-08-26).
//
// Turns supervision traffic — the pore's check-in/answer pairs recorded in
// lab_run_steps — into the evaluator's ActionEvidence vocabulary. Pure over
// its inputs so the mapping is testable without a database.
//
// v1 extracts the PORE signal only (approve / reject / edit). The composite
// set (deterministic validators, downstream reversals, sampled audit,
// calibrated judges) joins in later increments; the direction doc owns that
// commitment. What v1 already gets right:
//
//   · An answer authorizes THE fingerprinted action (Step 12 L2): evidence
//     is keyed to checkInAction.toolName, and the argsHash lets a rejection
//     followed by an approved DIFFERENT version of the same tool call be
//     upgraded to 'edited' — the "no, change this first" label, the most
//     informative one supervision produces.
//   · Unanswered check-ins produce NO evidence — a question the human never
//     answered says nothing about the agent.
//   · Only 'before-external-action' check-ins count. Budget and cron pores
//     are about the run, not about an action class.
import type { ActionEvidence, RiskTier } from './graduation.js';
import { situationSignature } from './gateway.js';
import { isAffirmative } from './loop.js';
import type { StepPayload } from './checkpoint.js';

export interface EvidenceStep {
  payload: StepPayload;
  createdAt: Date;
}

/** Pore evidence per action class (toolName), in observation order. */
export function extractPoreEvidence(steps: EvidenceStep[]): Map<string, ActionEvidence[]> {
  const out = new Map<string, ActionEvidence[]>();
  const push = (cls: string, e: ActionEvidence) => {
    out.set(cls, [...(out.get(cls) ?? []), e]);
  };
  // Rejections waiting for a possible edited re-proposal of the same tool.
  const openRejections: Array<{ cls: string; argsHash: string; evidence: ActionEvidence }> = [];

  let pending: { cls: string; argsHash: string; sig?: string | undefined } | null = null;
  for (const step of steps) {
    const p = step.payload;
    // W2 — the AUTONOMOUS stream (gate-allowed executions) is evidence too:
    //   · an execution that ERRORED is a machine-observed failure
    //     ('exec-failed', uncapped — nobody was watching, the record was);
    //   · a clean execution is NOT trust — a 200 proves the API worked,
    //     never that the action was right. Correctness arrives later as a
    //     validated audit verdict or an outcome report.
    if (p.kind === 'tool' && p.gate !== undefined && p.gate.decision === 'allow') {
      const errored =
        p.toolOutput !== null &&
        typeof p.toolOutput === 'object' &&
        typeof (p.toolOutput as { error?: unknown }).error === 'string';
      if (errored) {
        push(p.gate.actionClass, {
          at: step.createdAt,
          outcome: 'exec-failed',
          highStakes: false,
          ...(p.gate.audit === true ? { fromAudit: true } : {}),
          ...(p.gate.situation !== undefined ? { situation: p.gate.situation, situationSignature: p.gate.situation } : {}),
        });
      }
      continue;
    }
    if (p.kind === 'check-in' && p.checkInTrigger === 'before-external-action' && p.checkInAction) {
      let sig: string | undefined;
      try {
        sig = situationSignature(p.checkInAction.toolName, JSON.parse(p.checkInAction.arguments || '{}'));
      } catch { /* external argsSummary may not be JSON — no signature */ }
      pending = { cls: p.checkInAction.toolName, argsHash: p.checkInAction.argsHash, sig };
      continue;
    }
    if (pending !== null && p.checkInAnswer !== undefined) {
      const approvedNow = isAffirmative(p.checkInAnswer);
      if (approvedNow) {
        // An approved re-proposal of a tool that was just rejected with
        // DIFFERENT arguments upgrades that rejection to 'edited'.
        const idx = openRejections.findIndex(
          (r) => r.cls === pending!.cls && r.argsHash !== pending!.argsHash,
        );
        if (idx >= 0) {
          openRejections[idx]!.evidence.outcome = 'edited';
          openRejections.splice(idx, 1);
        }
        // situation = the Step-12 fingerprint: WHICH version of the action
        // was observed. The evaluator's diversity dimension reads it.
        push(pending.cls, { at: step.createdAt, outcome: 'approved', highStakes: false, situation: pending.argsHash, ...(pending.sig !== undefined ? { situationSignature: pending.sig } : {}) });
      } else {
        const evidence: ActionEvidence = { at: step.createdAt, outcome: 'rejected', highStakes: false, situation: pending.argsHash };
        push(pending.cls, evidence);
        openRejections.push({ cls: pending.cls, argsHash: pending.argsHash, evidence });
      }
      pending = null;
    }
  }
  return out;
}

/**
 * Risk tier for an action class, from the superpower catalog's act/read
 * classification plus optional spec-level overrides. FAIL CLOSED: a tool the
 * catalog cannot classify is treated as the most demanding gradable tier —
 * unknown consequence is high consequence (the Step 11 undeclared→act rule,
 * extended to tiers).
 */
export function tierFor(
  actionClass: string,
  classification: 'read' | 'act' | undefined,
  overrides: Readonly<Record<string, RiskTier>> = {},
): RiskTier {
  const override = overrides[actionClass];
  if (override !== undefined) return override;
  if (classification === 'read') return 'reversible-read';
  if (classification === 'act') return 'reversible-act';
  return 'irreversible-act';
}

/** W2 — evidence REPORTS (signals born outside the record: downstream
 * outcomes, reversals, incidents, audit verdicts) mapped into the same
 * vocabulary and merged per class. outcome-ok and audit-clean are the only
 * report kinds that BUY trust ('validated'); reversal/incident/audit-flagged
 * are failures, incidents high-stakes — the veto path. */
export function evidenceFromReports(
  reports: Array<{ actionClass: string; kind: 'outcome-ok' | 'reversal' | 'incident' | 'audit-clean' | 'audit-flagged'; createdAt: Date }>,
): Map<string, ActionEvidence[]> {
  const out = new Map<string, ActionEvidence[]>();
  for (const r of reports) {
    const e: ActionEvidence =
      r.kind === 'outcome-ok'
        ? { at: r.createdAt, outcome: 'validated', highStakes: false }
        : r.kind === 'audit-clean'
          ? { at: r.createdAt, outcome: 'validated', highStakes: false, fromAudit: true }
          : r.kind === 'audit-flagged'
            ? { at: r.createdAt, outcome: 'reversed', highStakes: false, fromAudit: true }
            : r.kind === 'incident'
              ? { at: r.createdAt, outcome: 'reversed', highStakes: true }
              : { at: r.createdAt, outcome: 'reversed', highStakes: false };
    out.set(r.actionClass, [...(out.get(r.actionClass) ?? []), e]);
  }
  return out;
}

/** Merge evidence maps in time order (the decision rules are order-aware
 * through timestamps; concatenation + sort keeps one stream per class). */
export function mergeEvidence(
  a: Map<string, ActionEvidence[]>,
  b: Map<string, ActionEvidence[]>,
): Map<string, ActionEvidence[]> {
  const out = new Map<string, ActionEvidence[]>();
  for (const m of [a, b]) {
    for (const [cls, list] of m) out.set(cls, [...(out.get(cls) ?? []), ...list]);
  }
  for (const [cls, list] of out) out.set(cls, [...list].sort((x, y) => x.at.getTime() - y.at.getTime()));
  return out;
}

/** W2 — the demonstrated-situation view: signatures of every action this
 * class earned POSITIVE evidence on (approvals, validations), derived from
 * the record + reports. The pass materializes this onto the grant row; the
 * gateway holds autonomous actions outside it. */
export function demonstratedSituations(evidence: ActionEvidence[]): string[] {
  const sigs = new Set<string>();
  for (const e of evidence) {
    if ((e.outcome === 'approved' || e.outcome === 'validated') && e.situationSignature !== undefined) {
      sigs.add(e.situationSignature);
    }
  }
  return [...sigs].sort();
}
