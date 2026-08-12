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
  // tool steps
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  // check-in steps
  checkInTrigger?: 'before-external-action' | 'on-budget-fraction' | 'cron';
  checkInQuestion?: string;
  checkInAnswer?: string;
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
