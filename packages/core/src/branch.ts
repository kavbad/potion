// CONDITIONAL EXECUTION, MEASURED (C3, docs/INFERENCE-COMPILER-PLAN.md).
//
// WHAT POTION ACTUALLY HAS, said precisely. The review asks for per-request
// routing: classify a request's difficulty, then route it. That is PREDICTIVE
// conditionality, and it is not built. What the compiler IR does have is
// REACTIVE conditionality — a program tries the cheap side, CHECKS the answer,
// and escalates when the check fails. The branch is decided per request, at
// runtime, from that request's own result.
//
// The difference is not cosmetic and reactive is the better-founded half:
// predictive routing GUESSES difficulty before paying for evidence, and is
// silently wrong when it guesses wrong; a check MEASURES it and cannot be
// silently wrong, because the failing check is the signal. What predictive
// routing buys is the second call back, on the requests where the cheap side
// would have sufficed.
//
// AND REACTIVE IS WHAT MAKES PREDICTIVE POSSIBLE. Every served program emits,
// per request, the label a difficulty classifier would need: did the cheap
// side hold, or did this request need more? That label is free, per-request
// and causally clean — the program actually ran both sides of its own
// decision. Which is why this module exists before any classifier does: you
// cannot fit a difficulty model without difficulty labels, and this is where
// they come from.

export type BranchVerdict = 'conditional' | 'always-worst-case' | 'never-escalates' | 'insufficient';

export interface BranchStats {
  n: number;
  /** Fraction of servings that ran the program's most expensive path. */
  worstCaseRate: number | null;
  verdict: BranchVerdict;
  reason: string;
}

/** Below this there is no rate, only noise. */
export const BRANCH_MIN_SERVINGS = 20;
/** Within this of 0 or 1, a gate is not deciding anything. */
export const BRANCH_DEGENERACY_BAND = 0.02;

/**
 * Is a conditional mechanism actually being conditional?
 *
 * A gate that ALWAYS escalates is not a gate — it is its escalation target
 * plus a wasted call, and strictly dominated by that target alone. A gate that
 * NEVER escalates is its cheap side plus a wasted check; the check is cheap,
 * but the escalation branch is untested and the program is claiming a safety
 * property it has never exercised.
 *
 * Both are DEGENERATE in the same sense the serving-degeneracy exclusion means
 * it: the suite measured a mechanism, and production is running something
 * simpler. Reported here so the frontier can be told; not silently corrected.
 *
 * @param pathLengths one entry per serving — how many stages that request ran
 * @param worstCase   the program's static call bound (programCallCount)
 */
export function branchStats(pathLengths: number[], worstCase: number): BranchStats {
  const n = pathLengths.length;
  if (n < BRANCH_MIN_SERVINGS) {
    return {
      n,
      worstCaseRate: null,
      verdict: 'insufficient',
      reason: `${n} serving(s), below the ${BRANCH_MIN_SERVINGS} needed to read a branch rate`,
    };
  }
  const worst = pathLengths.filter((len) => len >= worstCase).length;
  const rate = worst / n;
  if (rate >= 1 - BRANCH_DEGENERACY_BAND) {
    return {
      n,
      worstCaseRate: rate,
      verdict: 'always-worst-case',
      reason:
        `ran its ${worstCase}-call worst case on ${(rate * 100).toFixed(1)}% of servings — ` +
        `the gate is not saving anything, and the escalation target alone would be cheaper`,
    };
  }
  if (rate <= BRANCH_DEGENERACY_BAND) {
    return {
      n,
      worstCaseRate: rate,
      verdict: 'never-escalates',
      reason:
        `escalated on ${(rate * 100).toFixed(1)}% of servings — the cheap side alone would serve ` +
        `this traffic, and the escalation branch is untested in production`,
    };
  }
  return {
    n,
    worstCaseRate: rate,
    verdict: 'conditional',
    reason: `escalated on ${(rate * 100).toFixed(1)}% of servings — the gate is deciding`,
  };
}

/** The `path=` field of a recorded trace → how many stages ran. Absent or
 *  malformed yields null, never a zero that would read as "no calls". */
export function pathLengthOf(trace: string | null | undefined): number | null {
  if (!trace) return null;
  const m = /(?:^|;)path=([^;]+)/.exec(trace);
  if (!m) return null;
  const parts = m[1]!.split('>').filter((p) => p.length > 0);
  return parts.length > 0 ? parts.length : null;
}
