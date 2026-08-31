// Step payload construction + the secret gate (review addition 2).
//
// A checkpoint captures what the step SAW and DID, verbatim — never
// re-derivable inputs (the capstone lesson: re-derivation is where drift
// hides). Before any payload is written it is scanned with lab-spec's
// secret scanner; a hit REFUSES the write, fail-closed. Structurally, a
// checkpoint cannot contain key-shaped material: the guard is in the only
// constructor, not in review.
import { scanRawValue } from '@potion/lab-spec';
import type { ToolCall } from '@potion/core';

export interface StepPayload {
  kind: 'model' | 'tool' | 'check-in';
  // model steps
  requestPayload?: { model: string; messages: unknown[]; tools?: unknown[] };
  responseText?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  completionId?: string;
  frontierTrace?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** LABELED ESTIMATE (flat per-1K figure). The completionId join to
   * request_logs is the auditable number. */
  estCostUsd?: number;
  /** W0 (2026-08-31): the METERED charge for this step as billed by
   * serving (potion.cost_usd). The honest-cap rule spends this when
   * present and falls back to estCostUsd — the flat token heuristic
   * neither upper- nor lower-bounds real prices. Absent on old records
   * (their accounting derives exactly as before). */
  costUsd?: number;
  /** Step 8 (the toolPolicy activation): which policy slot served this
   * model step — calls carrying toolDefs are 'tools', deliberate tool-free
   * calls (the wrap-up) and toolless runs are 'brain'. */
  slot?: 'brain' | 'tools';
  // tool steps
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  /** Fresh-run leg start only: the memory snapshot AS SEEN when the system
   * prompt was built — what makes the record self-contained (Step 4). */
  memoryReads?: Record<string, unknown>;
  /** X2: the RENDERED task ledger this leg start re-injected (resume legs
   * only) — stamped so replay derives the identical conversation. */
  planLedger?: string;
  /**
   * Step 12 finding L8: the AUTHORED capability guidance that went into the
   * system prompt for this leg. Without it the record is not self-contained
   * for any run that loaded a superpower — replay re-derived the prompt
   * with no guidance and reported drift on a run that had not drifted, so
   * the self-containment theorem was false exactly where superpowers are.
   * Stamped beside memoryReads, on the same first-step-of-a-leg rule.
   */
  toolGuidance?: string[];
  // check-in steps
  checkInTrigger?: 'before-external-action' | 'on-budget-fraction' | 'cron' | 'worker-question';
  checkInQuestion?: string;
  /**
   * Step 12 finding L2 (CRITICAL) — the IDENTITY of the action the human
   * was shown. Before this, an answer authorized "the next external action"
   * rather than THE action on screen: approve `publish({body:'first'})`,
   * and on resume the model could emit `publish({body:'anything else'})`
   * and it ran ungated. The pore fired for one action and a different one
   * went out. The approval is now bound to this fingerprint.
   */
  checkInAction?: {
    toolName: string;
    argsHash: string;
    arguments: string;
    /** W0 (2026-08-31): per-call unique id so identical concurrent actions
     * never share an approval/audit identity. Optional — old records and
     * the hosted loop's fingerprint-bound path predate it. */
    actionId?: string;
  };
  checkInAnswer?: string;
  /** X8: operator steers folded into THIS model step's conversation —
   * replay re-injects them (steerMessage) before deriving the request. */
  steers?: string[];
  // nondeterminism taps, recorded so Step 4 replay can pin them
  clockMs: number;
  rngSample: number;
}

export class SecretInCheckpointError extends Error {
  constructor(path: string, detail: string) {
    super(
      `checkpoint refused — ${detail} at '${path}'. Credentials never live in run records; ` +
        'if a tool legitimately handles secrets, it must redact before returning.',
    );
    this.name = 'SecretInCheckpointError';
  }
}

export function buildStepPayload(input: Omit<StepPayload, 'estCostUsd'>): StepPayload {
  const payload: StepPayload = { ...input };
  if (input.usage !== undefined) {
    payload.estCostUsd = (input.usage.totalTokens / 1000) * 0.01;
  }
  // The gate. scanRawValue also reports control chars / dangerous keys /
  // depth; only secret-material refuses a checkpoint — model output may
  // legitimately contain odd characters, but never credentials.
  const secretHits = scanRawValue(payload).filter((i: { code: string }) => i.code === 'secret-material');
  if (secretHits.length > 0) {
    const first = secretHits[0]!;
    throw new SecretInCheckpointError(first.path, first.message);
  }
  return payload;
}
