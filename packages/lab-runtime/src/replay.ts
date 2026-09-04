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
import { parseBrief, type HarnessSpec } from '@potion/lab-spec';
import type { StepPayload } from './checkpoint.js';
import { checkInAnswerMessage, contractRepairMessage, doneFileRepairMessage, emptyStopRepairMessage, fileClaimRepairMessage, steerMessage, systemPrompt, toolResultMessage, wrapUpMessage, hasUnfilledSlot } from './loop.js';
import { fanOutSpentFromSteps } from './fanout.js';
import { decideAction } from './gateway.js';
import { planLedgerMessage } from './plan.js';

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
  let askedAlready = false;
  let sawToolStep = false;
  let budgetKillPending = false;
  // Step 8: a TOOL-BEARING task run ends with the loop's deliberate
  // tool-free wrap-up call — after a done-shaped step, expect exactly one
  // more model step derived as messages + wrapUpMessage().
  const runHadTools = ordered.some(
    (s) => s.kind === 'model' && (s.payload.requestPayload as { tools?: unknown } | undefined)?.tools !== undefined,
  );
  let expectWrapUp = false;
  // P1 contract law: repair rounds spent (mirrors the loop's conversation-derived count).
  let contractRepairs = 0;

  for (const step of ordered) {
    const p = step.payload;

    // X2: a leg-start LEDGER stamp injects the plan message first, then the
    // answer — the exact order the loop does it in (ledger, then answer).
    if (p.planLedger !== undefined && messages !== null) {
      messages.push(planLedgerMessage(p.planLedger));
    }
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
          // Step 12 (L8): re-derive with the RECORDED guidance, not with
          // an empty list — the leg's system prompt included it, so a
          // replay that omits it is comparing against a prompt that never
          // existed.
          messages = [
            { role: 'system', content: systemPrompt(spec, p.memoryReads, p.toolGuidance ?? []) },
            { role: 'user', content: 'Begin the mission.' },
          ];
        }
      }
      // X8 (mirrored): steers recorded ON this model step were pushed into
      // the conversation immediately before its request — re-derive them
      // with the SAME shared builder, after the first-step construction and
      // after any leg-start answer, exactly the loop's order.
      if (p.steers !== undefined && messages !== null) {
        for (const t of p.steers) messages.push(steerMessage(t));
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
        // W0 honest cap (mirrored same commit): spend the METERED charge
        // where money actually moved, the estimate as the activity bound
        // where it did not ($0 routes, old records) — exactly the loop's
        // rule. Old records have no costUsd and derive exactly as before.
        const metered = (p as { costUsd?: number }).costUsd;
        estSpent += metered !== undefined && metered > 0 ? metered : est;
      }
      // Adopt the RECORD to keep later comparisons local.
      messages = [...((p.requestPayload?.messages as ChatMessage[] | undefined) ?? messages)];
      messages.push({ role: 'assistant', content: p.responseText ?? '' });
      // THE FILE-CLAIMS LAW (mirrored same commit): a stamped step did NOT
      // complete — the loop pushed one repair round; re-derive the same
      // message from the recorded missing list.
      const fileClaims = (p as { fileClaimRepair?: string[] }).fileClaimRepair;
      if (fileClaims !== undefined) {
        messages.push(fileClaimRepairMessage(fileClaims));
        // THE LAW COVERS THE WRAP-UP (2026-09-01, mirrored same commit): a
        // STAMPED wrap-up annulled its completion attempt — the loop pushed
        // the repair and continued the mission, so the pending wrap-up
        // completion must not derive at record end.
        if (expectWrapUp) expectWrapUp = false;
      }
      // THE EMPTY-STOP LAW (2026-09-01, mirrored same commit): a stamped
      // report-less stop did NOT complete — the loop pushed one repair
      // round and continued the mission.
      // THE DONE-DEFINITION LAW (2026-09-03, mirrored same commit): a
      // stamped step did NOT complete — the mission's done-definition
      // named files the run did not hold; re-derive the same repair.
      const doneFiles = (p as { doneFileRepair?: string[] }).doneFileRepair;
      if (doneFiles !== undefined) {
        messages.push(doneFileRepairMessage(doneFiles));
        if (expectWrapUp) expectWrapUp = false;
      }
      const emptyStopStamp = (p as { emptyStopRepair?: boolean }).emptyStopRepair;
      if (emptyStopStamp === true) {
        messages.push(emptyStopRepairMessage());
      }
      // ask_operator (2026-08-31, mirrored same commit): calls stay pending —
      // a PARKED ask is cleared by its worker-question check-in below, and a
      // helper's refused ask is consumed by its recorded tool step like any
      // call. The record itself says which happened.
      pendingToolCalls = calls.map((c) => ({ name: c.function.name, args: c.function.arguments }));

      // THE UNFILLED-SLOT LAW (mirrored same commit): a task goal still
      // carrying an authored input slot cannot complete on its first no-tool
      // stop — the loop parked it as a worker-question; the check-in step
      // that follows derives the awaiting-human.
      const slotParked = spec.mission.kind === 'task' && !askedAlready && !sawToolStep && hasUnfilledSlot(spec.mission.goal);
      if (calls.length === 0 && p.finishReason === 'stop' && spec.mission.kind === 'task' && !slotParked && fileClaims === undefined && emptyStopStamp !== true) {
        if (runHadTools && !expectWrapUp) {
          // The wrap-up follows; terminal completes AFTER it.
          expectWrapUp = true;
          messages.push(wrapUpMessage());
        } else {
          derivedTerminal = { state: 'completed', atSeq: step.seq };
        }
      }
      // 2026-08-27 (mirrors the loop's law, same commit): a STANDING
      // mission's no-tool natural stop completes the CHECK — the replay
      // must derive what the loop now does, or every honest standing
      // record reads as divergence.
      // 2026-08-28 (P1 contract law, mirrored same commit): a
      // contract-bearing check completes ONLY on a parsed deliverable;
      // one repair round (the repair message re-derived from the SAME
      // recorded response text, so the next request comparison holds),
      // then a failed terminal. Contract-less standing is unchanged.
      if (calls.length === 0 && p.finishReason === 'stop' && spec.mission.kind === 'standing' && derivedTerminal === null && estSpent < spec.fuel.maxUsdPerRun) {
        if (spec.contract !== undefined) {
          const parsedBrief = parseBrief(p.responseText ?? '');
          // 2026-08-31 (mirrored same commit): a schema-valid but EMPTY
          // brief is not a completion — the loop runs one repair round then
          // fails; replay must derive the same or every hollow record reads
          // as a false 'completed'.
          const hollow = parsedBrief.ok
            && parsedBrief.brief.headline.length === 0 && parsedBrief.brief.byEntity.length === 0
            && parsedBrief.brief.quiet.length === 0 && parsedBrief.brief.coverage.checked === 0;
          if (parsedBrief.ok && !hollow) {
            derivedTerminal = { state: 'completed', atSeq: step.seq };
          } else if (contractRepairs < 1) {
            contractRepairs += 1;
            messages.push(contractRepairMessage(parsedBrief.ok
              ? ['the deliverable is empty — do the work and report what you found, or state honestly what you checked and why there is nothing (coverage must reflect real checking)']
              : parsedBrief.issues));
          } else {
            derivedTerminal = { state: 'failed', atSeq: step.seq };
          }
        } else {
          derivedTerminal = { state: 'completed', atSeq: step.seq };
        }
      }
      if (estSpent >= spec.fuel.maxUsdPerRun && derivedTerminal === null) {
        // W0 honest-cap test exposed the seam: the LOOP executes the
        // crossing step's tool calls first and kills at its next gate —
        // so a kill with pending calls DEFERS until the batch's tool
        // steps are consumed (the loop's true order, now mirrored).
        if (pendingToolCalls.length === 0) {
          derivedTerminal = { state: 'killed-budget', atSeq: step.seq };
        } else {
          budgetKillPending = true;
        }
      }
      continue;
    }

    if (step.kind === 'tool') {
      // Leg-start superpower notes (Step 10) are recorded as tool steps but
      // are CONTEXT, not responses to a model tool call — the loop pushes
      // them before the first model step. Replay treats them the same:
      // inject the message, never match a pending call. (This is what lets a
      // toolless fail-fast record — legNotes only, no model step — verify.)
      const isLegNote = (p.toolOutput as { superpowerUnavailable?: unknown } | null)?.superpowerUnavailable !== undefined;
      if (isLegNote) {
        if (messages !== null) messages.push(toolResultMessage(p.toolName ?? '?', p.toolOutput ?? null));
        continue;
      }
      sawToolStep = true;
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
      // W1 (mirrored same commit): a tool step carrying a gate payload is
      // an external call the Action Gateway decided — re-derive the
      // decision from the RECORDED snapshot + rng draw with the same pure
      // function. A decision that does not follow from its own recorded
      // justification is a divergence (A1: the record carries WHY).
      const gate = (p as { gate?: { actionClass: string; ceiling: 'earnable' | 'ask-forever' | 'barred'; grantState: 'supervised' | 'autonomous' | 'blocked' | 'none'; auditRate: number; decision: string; audit?: boolean; sample: number; situation?: string; knownSituations?: string[] } }).gate;
      if (gate !== undefined) {
        const rederived = decideAction(
          {
            actionClass: gate.actionClass, ceiling: gate.ceiling, grantState: gate.grantState, auditRate: gate.auditRate,
            ...(gate.situation !== undefined ? { situation: gate.situation } : {}),
            ...(gate.knownSituations !== undefined ? { knownSituations: gate.knownSituations } : {}),
          },
          gate.sample,
        );
        const expectedGate = rederived.decision === 'allow'
          ? { decision: 'allow', audit: rederived.audit }
          : { decision: rederived.decision };
        const recordedGate = { decision: gate.decision, ...(gate.decision === 'allow' ? { audit: gate.audit } : {}) };
        if (canonicalJson(expectedGate) !== canonicalJson(recordedGate)) {
          divergences.push(div('payload-mismatch', step.seq, expectedGate, recordedGate, 'gate'));
        }
      }
      // X4 (one fuel tree, mirrored): a delegate step's recorded helper
      // spend counts against the family cap at exactly this point — the
      // same pure derivation the loop uses.
      estSpent += fanOutSpentFromSteps([{ kind: 'tool', payload: { toolName: p.toolName, toolOutput: p.toolOutput } }]);
      if (budgetKillPending && pendingToolCalls.length === 0 && derivedTerminal === null) {
        derivedTerminal = { state: 'killed-budget', atSeq: step.seq };
        budgetKillPending = false;
      }
      if (messages !== null) {
        messages.push(toolResultMessage(p.toolName ?? '?', p.toolOutput ?? null));
      }
      continue;
    }

    // check-in step: it suspends the run; anything AFTER it belongs to a
    // resumed leg (whose first step carries checkInAnswer, handled above).
    // A worker-question park (2026-08-31) abandons any calls that followed
    // the ask in the same response — the loop dropped them, so does replay.
    if ((p as { checkInTrigger?: string }).checkInTrigger === 'worker-question') {
      pendingToolCalls = [];
      askedAlready = true;
    }
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
  // The wrap-up is OPTIONAL by the loop's own rule ("a failed wrap-up never
  // blocks completion") — a record ending at the done-shaped step with the
  // wrap-up expected-but-absent is a legitimate completion, not a
  // divergence (review finding: replay must tolerate what the loop does).
  if (derivedTerminal === null && expectWrapUp) {
    derivedTerminal = { state: 'completed', atSeq: lastSeq };
  }
  // 2026-08-31 (mirrors the loop's HONEST START fail-fast): a run that
  // never called the model (a worker born toolless, failed before any
  // model step) has no conversation to derive — the recorded terminal
  // stands unchallenged. A record WITH model steps but no derived terminal
  // is still the leg-cap 'running' case.
  const expectedState = derivedTerminal?.state ?? (modelSteps === 0 ? terminal.state : 'running');
  if (expectedState !== terminal.state) {
    divergences.push(div('terminal-state', lastSeq, expectedState, terminal.state, 'state'));
  }

  return divergences.length === 0
    ? { ok: true, steps: ordered.length, modelSteps }
    : { ok: false, divergences };
}
