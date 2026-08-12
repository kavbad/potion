// Pure playback (Step 4) — THE definition of done for deterministic replay.
//
// replayRun re-derives every model step's request from the record alone and
// compares byte-for-byte (canonicalJson) against what was recorded. Zero
// provider calls, zero serving, zero network, zero database: the signature
// is the fence — this function takes LOADED steps, not a db handle, so a
// future edit cannot quietly make playback write or spend.
//
// The theorem: the record is self-contained and the loop is a deterministic
// function of it. The derivation uses the loop's OWN exported helpers
// (systemPrompt / conversationFromSteps / checkInAnswerMessage /
// toolResultMessage) — a re-implementation here would make the test about
// the re-implementation, not the loop.
//
// Divergences are typed and ALL collected (the Step 2 discipline). After a
// model step is compared, the RECORDED request is adopted for the next
// derivation, so one drift stays local instead of cascading through the
// stream.
import { canonicalJson, sha256, type ChatMessage } from '@potion/core';
import type { HarnessSpec } from '@potion/lab-spec';
import type { StepPayload } from './checkpoint.js';
import { checkInAnswerMessage, systemPrompt, toolResultMessage } from './loop.js';

export type ReplayDivergenceCode =
  | 'request-drift'
  | 'stream-shape'
  | 'terminal-state'
  | 'record-exhausted'
  | 'record-unconsumed'
  | 'payload-mismatch';

export interface ReplayDivergence {
  code: ReplayDivergenceCode;
  seq: number;
  field?: string;
  expectedHash: string;
  actualHash: string;
  /** Capped excerpt for humans; hashes are the comparison. */
  excerpt: string;
}

export interface RecordedStep {
  seq: number;
  kind: 'model' | 'tool' | 'check-in';
  payload: StepPayload;
}

export interface RecordedTerminal {
  state: string;
  reason?: string | null;
}

export type ReplayResult =
  | { ok: true; steps: number; modelSteps: number }
  | { ok: false; divergences: ReplayDivergence[] };

const EXCERPT = 160;

function div(
  code: ReplayDivergenceCode,
  seq: number,
  expected: unknown,
  actual: unknown,
  field?: string,
): ReplayDivergence {
  const e = canonicalJson(expected ?? null);
  const a = canonicalJson(actual ?? null);
  return {
    code,
    seq,
    ...(field !== undefined ? { field } : {}),
    expectedHash: sha256(e),
    actualHash: sha256(a),
    excerpt: `expected ${e.slice(0, EXCERPT)} … actual ${a.slice(0, EXCERPT)}`,
  };
}

export function replayRun(
  spec: HarnessSpec,
  steps: RecordedStep[],
  terminal: RecordedTerminal,
): ReplayResult {
  const divergences: ReplayDivergence[] = [];
  const ordered = [...steps].sort((x, y) => x.seq - y.seq);

  // Stream shape: seqs must be 1..N contiguous.
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.seq !== i + 1) {
      divergences.push(div('stream-shape', ordered[i]!.seq, i + 1, ordered[i]!.seq, 'seq'));
    }
  }

  let messages: ChatMessage[] | null = null;
  let pendingToolCalls: Array<{ name: string; args: string }> = [];
  let estSpent = 0;
  let modelSteps = 0;
  let derivedTerminal: { state: string; atSeq: number } | null = null;

  for (const step of ordered) {
    const p = step.payload;

    // A leg-start answer stamp injects the answer message BEFORE this step's
    // derivation — the same order the loop does it in.
    if (p.checkInAnswer !== undefined && messages !== null) {
      messages.push(checkInAnswerMessage(p.checkInAnswer));
    }

    if (step.kind === 'model') {
      modelSteps += 1;
      if (messages === null) {
        // The run's first model step must carry the memory snapshot — without
        // it the record is not self-contained and the system prompt cannot be
        // re-derived.
        if (p.memoryReads === undefined) {
          divergences.push(
            div('payload-mismatch', step.seq, 'memoryReads present', 'missing', 'memoryReads'),
          );
          messages = (p.requestPayload?.messages as ChatMessage[] | undefined) ?? [];
        } else {
          messages = [
            { role: 'system', content: systemPrompt(spec, p.memoryReads) },
            { role: 'user', content: 'Begin the mission.' },
          ];
        }
      }
      // THE COMPARISON: the re-derived request vs the recorded one.
      const derived = { model: 'potion-auto', messages };
      const recorded = {
        model: p.requestPayload?.model,
        messages: p.requestPayload?.messages,
      };
      if (canonicalJson(derived) !== canonicalJson(recorded)) {
        divergences.push(div('request-drift', step.seq, derived, recorded, 'requestPayload'));
      }
      // Copied-field consistency: finishReason vs toolCalls presence.
      const calls = p.toolCalls ?? [];
      if (calls.length > 0 && p.finishReason === 'stop') {
        divergences.push(
          div('payload-mismatch', step.seq, 'tool_calls', p.finishReason, 'finishReason'),
        );
      }
      // estCost recomputes from recorded usage.
      if (p.usage !== undefined) {
        const est = (p.usage.totalTokens / 1000) * 0.01;
        if (p.estCostUsd !== undefined && Math.abs(p.estCostUsd - est) > 1e-12) {
          divergences.push(div('payload-mismatch', step.seq, est, p.estCostUsd, 'estCostUsd'));
        }
        estSpent += est;
      }
      // Adopt the RECORD to keep later comparisons local.
      messages = [...((p.requestPayload?.messages as ChatMessage[] | undefined) ?? messages)];
      messages.push({ role: 'assistant', content: p.responseText ?? '' });
      pendingToolCalls = calls.map((c) => ({ name: c.function.name, args: c.function.arguments }));

      if (calls.length === 0 && p.finishReason === 'stop' && spec.mission.kind === 'task') {
        derivedTerminal = { state: 'completed', atSeq: step.seq };
      }
      if (estSpent >= spec.fuel.maxUsdPerRun && derivedTerminal === null) {
        derivedTerminal = { state: 'killed-budget', atSeq: step.seq };
      }
      continue;
    }

    if (step.kind === 'tool') {
      const expected = pendingToolCalls.shift();
      if (expected === undefined) {
        divergences.push(div('stream-shape', step.seq, 'no pending tool call', p.toolName, 'kind'));
      } else {
        if (p.toolName !== expected.name) {
          divergences.push(div('request-drift', step.seq, expected.name, p.toolName, 'toolName'));
        }
        const expectedInput: unknown = JSON.parse(expected.args || '{}');
        if (canonicalJson(expectedInput) !== canonicalJson(p.toolInput ?? {})) {
          divergences.push(div('request-drift', step.seq, expectedInput, p.toolInput, 'toolInput'));
        }
      }
      if (messages !== null) {
        messages.push(toolResultMessage(p.toolName ?? '?', p.toolOutput ?? null));
      }
      continue;
    }

    // check-in step: it suspends the run; anything AFTER it belongs to a
    // resumed leg (whose first step carries checkInAnswer, handled above).
    if (derivedTerminal === null) {
      derivedTerminal = { state: 'awaiting-human', atSeq: step.seq };
    }
  }

  // Terminal reconciliation. A non-terminal record (leg cap) legitimately
  // ends 'running'; an awaiting-human derived terminal is CLEARED when the
  // record continues past it (the resumed leg consumed the answer).
  const lastSeq = ordered.length > 0 ? ordered[ordered.length - 1]!.seq : 0;
  if (derivedTerminal !== null && derivedTerminal.atSeq < lastSeq) {
    if (derivedTerminal.state === 'awaiting-human') derivedTerminal = null;
    else {
      divergences.push(
        div('record-unconsumed', derivedTerminal.atSeq + 1, `terminal ${derivedTerminal.state} at seq ${derivedTerminal.atSeq}`, `record continues to seq ${lastSeq}`),
      );
    }
  }
  if (pendingToolCalls.length > 0 && terminal.state !== 'awaiting-human' && terminal.state !== 'failed') {
    divergences.push(
      div('record-exhausted', lastSeq, `${pendingToolCalls.length} pending tool call(s) executed`, 'record ends'),
    );
  }
  const expectedState = derivedTerminal?.state ?? 'running';
  if (expectedState !== terminal.state) {
    divergences.push(div('terminal-state', lastSeq, expectedState, terminal.state, 'state'));
  }

  return divergences.length === 0
    ? { ok: true, steps: ordered.length, modelSteps }
    : { ok: false, divergences };
}
