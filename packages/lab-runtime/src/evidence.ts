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

  let pending: { cls: string; argsHash: string } | null = null;
  for (const step of steps) {
    const p = step.payload;
    if (p.kind === 'check-in' && p.checkInTrigger === 'before-external-action' && p.checkInAction) {
      pending = { cls: p.checkInAction.toolName, argsHash: p.checkInAction.argsHash };
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
        push(pending.cls, { at: step.createdAt, outcome: 'approved', highStakes: false });
      } else {
        const evidence: ActionEvidence = { at: step.createdAt, outcome: 'rejected', highStakes: false };
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
