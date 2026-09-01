// W1 — the Action Gateway (WORKERS-DIRECTION, 2026-08-31). ONE truth about
// what a worker may do, for every runtime. The decision is a PURE function
// of a recorded snapshot + a recorded rng sample, because the record must
// carry WHY (A1: a gateway decision replay cannot re-derive does not ship).
//
// The door law (A2): this is NOT the removed "already authorized" branch.
// One-shot approvals (the pore's answer consumption, Step 12 L2/L3/L4)
// authorize THE action a human read, byte for byte, exactly once. The
// gateway consults STANDING grants — earned through acceptGraduation's
// human-accept path, revocable by tightenGrant at any moment — and reads
// them fresh at act time, so a tighten written anywhere bites the very
// next action everywhere.
//
// Decision order (first match wins):
//   ceiling 'barred'          → block   (the constitution bars the class)
//   grant state 'blocked'     → block   (the trust record bars it)
//   ceiling 'ask-forever'     → hold    (approvable forever, autonomous never
//                                        — even a mistaken 'autonomous' row
//                                        cannot out-rank the constitution)
//   grant state 'autonomous'  → allow   (audit-sampled at ≥ the floor —
//                                        unaudited autonomy is unmeasured)
//   otherwise                 → hold    (born supervised)
import { AUDIT_RATE_FLOOR } from './graduation.js';

/** The constitution's per-action-class maximum authority (spec field). */
export type ConstitutionCeiling = 'earnable' | 'ask-forever' | 'barred';

/** Everything the decision depends on — recorded verbatim in the step
 * payload so replay re-derives the decision from the record alone. */
export interface GateSnapshot {
  actionClass: string;
  ceiling: ConstitutionCeiling;
  /** 'none' = no grant row existed at act time (born supervised). */
  grantState: 'supervised' | 'autonomous' | 'blocked' | 'none';
  auditRate: number;
  /** W2 — distribution membership: this action's situation signature and
   * the demonstrated set from the grant row (materialized from records by
   * the graduation pass). Authority applies only inside the region where
   * competence was demonstrated: an autonomous action OUTSIDE the set
   * escalates to a hold. Absent fields (old records, empty set) skip the
   * check — no set means no demonstrated boundary yet. */
  situation?: string;
  knownSituations?: string[];
}

export type GateDecision =
  | { decision: 'allow'; audit: boolean }
  | { decision: 'hold' }
  | { decision: 'block'; reason: string };

export function decideAction(snap: GateSnapshot, rngSample: number): GateDecision {
  if (snap.ceiling === 'barred') {
    return { decision: 'block', reason: `the worker's constitution bars '${snap.actionClass}' entirely` };
  }
  if (snap.grantState === 'blocked') {
    return { decision: 'block', reason: `the trust record blocks '${snap.actionClass}' for this worker` };
  }
  if (snap.ceiling === 'ask-forever') {
    return { decision: 'hold' };
  }
  if (snap.grantState === 'autonomous') {
    if (
      snap.situation !== undefined &&
      snap.knownSituations !== undefined &&
      snap.knownSituations.length > 0 &&
      !snap.knownSituations.includes(snap.situation)
    ) {
      return { decision: 'hold' }; // outside the demonstrated region — ask
    }
    return { decision: 'allow', audit: rngSample < Math.max(snap.auditRate, AUDIT_RATE_FLOOR) };
  }
  return { decision: 'hold' };
}

/** W2 — the situation signature: the action's PARAM SHAPE (sorted keys)
 * plus the discriminating small enum-ish value ('kind') when present.
 * Coarser than the argsHash fingerprint (which individuates every call),
 * finer than the bare class — the v1 region vocabulary. Pure. */
export function situationSignature(actionClass: string, input: unknown): string {
  const obj = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const keys = Object.keys(obj).sort();
  const kind = typeof obj.kind === 'string' && obj.kind.length <= 16 ? `:${obj.kind}` : '';
  return `${actionClass}(${keys.join(',')})${kind}`;
}

/** The spec's ceiling for an action class (absent constitution or entry =
 * 'earnable' — the default leash; the grant record still starts supervised). */
export function ceilingFor(
  constitution: ReadonlyArray<{ action: string; maxAuthority: ConstitutionCeiling }> | undefined,
  actionClass: string,
): ConstitutionCeiling {
  return constitution?.find((c) => c.action === actionClass)?.maxAuthority ?? 'earnable';
}

/** W1 — the constitution feeds the graduation pass: an 'ask-forever'
 * ceiling pins the never-graduates tier (the pass can then never propose
 * autonomy for it), and 'barred' classes are excluded from proposals
 * entirely at the gateway. 'earnable' leaves the classification-derived
 * tier alone. */
export function constitutionTierOverrides(
  constitution: ReadonlyArray<{ action: string; maxAuthority: ConstitutionCeiling }> | undefined,
): Record<string, 'never-graduates'> {
  const out: Record<string, 'never-graduates'> = {};
  for (const c of constitution ?? []) {
    if (c.maxAuthority === 'ask-forever' || c.maxAuthority === 'barred') out[c.action] = 'never-graduates';
  }
  return out;
}
