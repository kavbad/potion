// The loop executor: leg-per-invocation, checkpoint-per-step, fenced writes.
//
// A run is durable rows adopted by one invocation at a time (claimLabRun).
// The leg executes steps until: the mission completes, a check-in suspends
// it, fuel or the org budget kills it, the leg step cap is reached
// (standing missions), or an error terminates it. Every completed step is a
// verbatim checkpoint (checkpoint.ts) — secret-scanned before write, written
// transactionally with the cursor, fenced against zombies.
//
// DIVERGENCE TABLE (driver-semantics lesson) for the injected doubles:
//   Clock  — tests inject a settable clock; the real one (Date.now) can jump
//            BACKWARDS under NTP. Nothing here subtracts clock readings
//            across steps; per-step `clockMs` is a recording, not arithmetic.
//   Rng    — mulberry32 seeded from the runId: deterministic per run, unlike
//            Math.random. Recorded per step so replay can pin it.
//   sleep  — injected; tests make it instant. The retry test asserts on the
//            REQUESTED delays, not wall-clock (a fake sleep proves ordering,
//            never duration).
import { seedFromString, type ChatMessage, type Tool } from '@potion/core';
import {
  appendLabStep,
  claimLabRun,
  getLabMemory,
  transitionLabRun,
  releaseLabRunLease,
  listLabSteps,
  type LabClaim,
  type PotionDb,
} from '@potion/db';
import type { HarnessSpec } from '@potion/lab-spec';
import { buildStepPayload, SecretInCheckpointError, type StepPayload } from './checkpoint.js';
import type { ServingClient } from './serving-client.js';

export interface LabTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Whether invoking it acts on the world outside the platform — gates the
   * before-external-action check-in. */
  external: boolean;
  run(input: unknown): Promise<unknown>;
}

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** The exact message shape a consumed check-in answer becomes. Exported so
 * replay derives it from the SAME code, never a re-implementation. */
/** Step 8 (the toolPolicy activation): the loop's ONE deliberate tool-free
 * call — issued without tools at the end of a TOOL-BEARING task run,
 * served under brain.policy's ref, stamped slot 'brain'. Its text feeds
 * run report v1's "what happened". Exported for replay derivation. */
export const WRAP_UP_PROMPT =
  'Summarize what you did in this run and state plainly whether the done-definition is met.';

export function wrapUpMessage(): ChatMessage {
  return { role: 'user', content: WRAP_UP_PROMPT };
}

export function checkInAnswerMessage(answer: string): ChatMessage {
  return { role: 'user', content: `[check-in answer] ${answer}` };
}

/** The exact message shape a tool result becomes (same reasoning). */
export function toolResultMessage(toolName: string, output: unknown): ChatMessage {
  return { role: 'user', content: `[tool ${toolName} result] ${JSON.stringify(output)}` };
}

export interface RunLegOptions {
  db: PotionDb;
  client: ServingClient;
  runId: string;
  orgId: string;
  spec: HarnessSpec;
  harnessHash: string;
  tools?: LabTool[];
  /** Step 10: typed leg-start records from MCP setup (expired / revoked /
   * unreachable superpowers). Each is checkpointed as a tool step AND
   * pushed into the conversation, so the record and what the model saw
   * stay identical (requestPayload self-containment carries it to replay).
   * Never silent: a superpower that could not serve this leg says so. */
  legNotes?: Array<{ toolName: string; note: unknown }>;
  /** Step 11 §7: authored per-package usage preambles for the connectors
   * whose tools loaded this leg (see systemPrompt). */
  toolGuidance?: readonly string[];
  /** Step 8 per-slot policy pins (the dial's materialized rows): tool-capable
   * calls ride tools ?? brain; tool-free calls (incl. the wrap-up) ride brain. */
  policyRefs?: { brain?: string; tools?: string };
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  maxStepsPerLeg?: number;
  leaseMs?: number;
  rateRetries?: number;
}

export type LegOutcome =
  | { status: 'completed'; steps: number }
  | { status: 'awaiting-human'; question: string; steps: number }
  | { status: 'killed-budget'; reason: string; steps: number }
  | { status: 'failed'; reason: string; steps: number }
  | { status: 'leg-cap'; steps: number }
  | { status: 'refused'; reason: string; detail: string };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** System prompt: mission + rules + memory snapshot. Deterministic given the
 * same spec + memory — this text is part of every step's requestPayload. */
export function systemPrompt(
  spec: HarnessSpec,
  memory: Record<string, unknown>,
  /** Step 11 §7: AUTHORED capability guidance from the catalog packages
   * whose tools actually loaded this leg. Trusted, curated text — never a
   * server string (the provenance rule). Empty when no superpower loaded,
   * so a brain-only run's prompt is byte-identical to before. */
  toolGuidance: readonly string[] = [],
): string {
  const mission =
    spec.mission.kind === 'task'
      ? `Mission (task): ${spec.mission.goal}\nDone when: ${spec.mission.doneDefinition}`
      : `Mission (standing): ${spec.mission.goal}`;
  const rules = spec.rules.length > 0 ? `\nRules:\n${spec.rules.map((r) => `- ${r}`).join('\n')}` : '';
  const mem =
    Object.keys(memory).length > 0
      ? `\nMemory:\n${JSON.stringify(memory, Object.keys(memory).sort())}`
      : '';
  const guidance =
    toolGuidance.length > 0 ? `\nYour connected superpowers:\n${toolGuidance.map((g) => `- ${g}`).join('\n')}` : '';
  return `You are a harness named '${spec.name}'.\n${mission}${rules}${mem}${guidance}\nWhen the mission is complete, answer normally with no tool calls.`;
}

/** Rebuild the conversation from checkpointed steps — replay-grade: the
 * verbatim recorded messages, never a re-derivation. */
export function conversationFromSteps(steps: Array<{ kind: string; payload: unknown }>): ChatMessage[] {
  const last = [...steps].reverse().find((s) => s.kind === 'model');
  if (!last) return [];
  const p = last.payload as StepPayload;
  if (p.requestPayload === undefined) return [];
  const messages: ChatMessage[] = [...(p.requestPayload.messages as ChatMessage[])];
  messages.push({ role: 'assistant', content: p.responseText ?? '' });
  // Tool steps after the last model step become tool-result user messages.
  const lastIdx = steps.lastIndexOf(last);
  for (const s of steps.slice(lastIdx + 1)) {
    if (s.kind === 'tool') {
      const tp = s.payload as StepPayload;
      messages.push(toolResultMessage(tp.toolName ?? '?', tp.toolOutput ?? null));
    }
  }
  return messages;
}

export async function runLeg(opts: RunLegOptions): Promise<LegOutcome> {
  const clock = opts.clock ?? systemClock;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const leaseMs = opts.leaseMs ?? 120_000;
  const maxSteps = opts.maxStepsPerLeg ?? 25;
  const tools = opts.tools ?? [];
  const rng = mulberry32(seedFromString(opts.runId) % 2 ** 31);

  const claim: LabClaim = await claimLabRun(opts.db, {
    runId: opts.runId,
    orgId: opts.orgId,
    expectedHarnessHash: opts.harnessHash,
    leaseMs,
    now: new Date(clock.now()),
  });
  if (!claim.ok) return { status: 'refused', reason: claim.reason, detail: claim.detail };
  const fence = claim.fence;
  let seq = claim.cursorSeq;

  const fenced = {
    transition: (to: Parameters<typeof transitionLabRun>[1]['to'], reason?: string, question?: string) =>
      transitionLabRun(opts.db, {
        runId: opts.runId, orgId: opts.orgId, fence, to,
        ...(reason !== undefined ? { reason } : {}),
        ...(question !== undefined ? { question } : {}),
        now: new Date(clock.now()),
      }),
  };

  try {
    const priorSteps = await listLabSteps(opts.db, opts.runId, opts.orgId);
    const memory = await getLabMemory(opts.db, opts.orgId, opts.harnessHash);
    let messages: ChatMessage[];
    if (priorSteps.length === 0) {
      messages = [
        { role: 'system', content: systemPrompt(opts.spec, memory, opts.toolGuidance ?? []) },
        { role: 'user', content: 'Begin the mission.' },
      ];
    } else {
      messages = conversationFromSteps(priorSteps);
      if (claim.pendingAnswer !== null) {
        messages.push(checkInAnswerMessage(claim.pendingAnswer));
      }
    }

    // Per-run fuel accounting: estimates from checkpointed usage. Labeled an
    // estimate everywhere; the completionId join to request_logs is truth.
    let estSpentUsd = priorSteps.reduce(
      (acc, s) => acc + ((s.payload as StepPayload).estCostUsd ?? 0),
      0,
    );
    // A recorded check-in answer AUTHORIZES the next external action, once —
    // but ONLY when the question it answered WAS the external-action gate
    // (review finding: a fuel check-in's "keep going" must never authorize
    // an external action the human was not shown). Without consumption
    // semantics the resumed leg would re-ask on the very tool call the
    // human just approved — an infinite politeness loop.
    const lastCheckIn = [...priorSteps].reverse().find((s) => s.kind === 'check-in');
    let externalAuthorized =
      claim.pendingAnswer !== null &&
      (lastCheckIn?.payload as StepPayload | undefined)?.checkInTrigger === 'before-external-action';
    let budgetFractionAsked = priorSteps.some(
      (s) => s.kind === 'check-in' && (s.payload as StepPayload).checkInTrigger === 'on-budget-fraction',
    );

    const toolDefs: Tool[] | undefined =
      tools.length > 0
        ? tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;

    // Step 4 (recorded finding): the Step 3 spec's checkpoint table promised
    // memoryReads and checkInAnswer; the build never populated them, which
    // makes a record NON-self-contained (replay cannot re-derive the system
    // prompt or the answer injection). The first step a leg appends now
    // carries them.
    let legStamp: Partial<StepPayload> | null =
      priorSteps.length === 0
        ? { memoryReads: memory }
        : claim.pendingAnswer !== null
          ? { checkInAnswer: claim.pendingAnswer }
          : null;
    const takeLegStamp = (): Partial<StepPayload> => {
      const stamp = legStamp ?? {};
      legStamp = null;
      return stamp;
    };

    // ---- Step 10 leg notes: typed superpower states, recorded + shown ----
    for (const legNote of opts.legNotes ?? []) {
      seq += 1;
      await appendLabStep(opts.db, {
        runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'tool',
        payload: buildStepPayload({
          ...takeLegStamp(),
          kind: 'tool', toolName: legNote.toolName, toolOutput: legNote.note,
          clockMs: clock.now(), rngSample: rng(),
        }),
        harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
      });
      messages.push(toolResultMessage(legNote.toolName, legNote.note));
    }

    let stepsThisLeg = 0;
    while (stepsThisLeg < maxSteps) {
      // ---- fuel hard stop (harness-level; the org-level one is serving's) ----
      if (estSpentUsd >= opts.spec.fuel.maxUsdPerRun) {
        await fenced.transition('killed-budget', `fuel exhausted: est $${estSpentUsd.toFixed(4)} >= maxUsdPerRun $${opts.spec.fuel.maxUsdPerRun}`);
        return { status: 'killed-budget', reason: 'fuel', steps: stepsThisLeg };
      }
      // ---- on-budget-fraction check-in ----
      const fractionTrigger = opts.spec.checkIns.find((c) => c.trigger === 'on-budget-fraction');
      if (
        fractionTrigger !== undefined &&
        'fraction' in fractionTrigger &&
        !budgetFractionAsked &&
        estSpentUsd / opts.spec.fuel.maxUsdPerRun >= fractionTrigger.fraction
      ) {
        const question = `Fuel check-in: ~$${estSpentUsd.toFixed(4)} of $${opts.spec.fuel.maxUsdPerRun} used (${Math.round((estSpentUsd / opts.spec.fuel.maxUsdPerRun) * 100)}%). Continue?`;
        seq += 1;
        await appendLabStep(opts.db, {
          runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'check-in',
          payload: buildStepPayload({ ...takeLegStamp(), kind: 'check-in', checkInTrigger: 'on-budget-fraction', checkInQuestion: question, clockMs: clock.now(), rngSample: rng() }),
          harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
        });
        budgetFractionAsked = true;
        await fenced.transition('awaiting-human', undefined, question);
        return { status: 'awaiting-human', question, steps: stepsThisLeg };
      }

      // ---- model step (with bounded rate-limit retry) ----
      const slot: 'brain' | 'tools' = toolDefs ? 'tools' : 'brain';
      const slotRef = toolDefs
        ? (opts.policyRefs?.tools ?? opts.policyRefs?.brain)
        : opts.policyRefs?.brain;
      const requestPayload = { model: 'potion-auto', messages: [...messages], ...(toolDefs ? { tools: toolDefs } : {}) };
      let result = await opts.client.complete({ messages, ...(toolDefs ? { tools: toolDefs } : {}), ...(slotRef !== undefined ? { policyRef: slotRef } : {}) });
      for (let retry = 0; result.kind === 'rate-limited' && retry < (opts.rateRetries ?? 3); retry++) {
        await sleep(result.retryAfterMs);
        result = await opts.client.complete({ messages, ...(toolDefs ? { tools: toolDefs } : {}), ...(slotRef !== undefined ? { policyRef: slotRef } : {}) });
      }
      if (result.kind === 'budget-exceeded') {
        // The ORG hard stop — serving refused to spend. Terminal.
        await fenced.transition('killed-budget', `org budget hard stop: ${result.detail}`);
        return { status: 'killed-budget', reason: 'org-budget', steps: stepsThisLeg };
      }
      if (result.kind === 'rate-limited' || result.kind === 'error') {
        const reason = result.kind === 'rate-limited' ? 'rate limit retries exhausted' : `serving error ${result.code}: ${result.detail}`;
        await fenced.transition('failed', reason);
        return { status: 'failed', reason, steps: stepsThisLeg };
      }

      seq += 1;
      await appendLabStep(opts.db, {
        runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'model',
        payload: buildStepPayload({
          ...takeLegStamp(),
          kind: 'model', slot, requestPayload, responseText: result.text,
          toolCalls: result.toolCalls, finishReason: result.finishReason,
          completionId: result.completionId, frontierTrace: result.frontierTrace,
          usage: result.usage, clockMs: clock.now(), rngSample: rng(),
        }),
        harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
      });
      stepsThisLeg += 1;
      // Cost estimate: usage is real; the price is serving's concern — v1
      // estimates conservatively from tokens at a flat per-1K figure recorded
      // in the payload. The join to request_logs is the auditable number.
      const stepEst = (result.usage.totalTokens / 1000) * 0.01;
      estSpentUsd += stepEst;
      messages.push({ role: 'assistant', content: result.text });

      if (result.toolCalls.length > 0) {
        for (const call of result.toolCalls) {
          const tool = tools.find((t) => t.name === call.function.name);
          if (!tool) {
            await fenced.transition('failed', `model called unknown tool '${call.function.name}'`);
            return { status: 'failed', reason: 'unknown-tool', steps: stepsThisLeg };
          }
          // ---- before-external-action check-in ----
          const gate = opts.spec.checkIns.some((c) => c.trigger === 'before-external-action');
          if (gate && tool.external && externalAuthorized) {
            externalAuthorized = false; // consumed — one answer, one action
          } else if (gate && tool.external) {
            const question = `About to run external tool '${tool.name}' with input ${JSON.stringify(call.function.arguments).slice(0, 200)}. Proceed?`;
            seq += 1;
            await appendLabStep(opts.db, {
              runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'check-in',
              payload: buildStepPayload({ ...takeLegStamp(), kind: 'check-in', checkInTrigger: 'before-external-action', checkInQuestion: question, clockMs: clock.now(), rngSample: rng() }),
              harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
            });
            await fenced.transition('awaiting-human', undefined, question);
            return { status: 'awaiting-human', question, steps: stepsThisLeg };
          }
          const input: unknown = JSON.parse(call.function.arguments || '{}');
          const output = await tool.run(input);
          seq += 1;
          await appendLabStep(opts.db, {
            runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'tool',
            payload: buildStepPayload({
              ...takeLegStamp(),
              kind: 'tool', toolName: tool.name, toolInput: input, toolOutput: output,
              clockMs: clock.now(), rngSample: rng(),
            }),
            harnessHash: opts.harnessHash,
            // Simple convention v1: a tool may return {_memoryWrites: {...}}
            // to persist harness memory; recorded in the step AND projected.
            ...(isMemoryCarrier(output) ? { memoryWrites: output._memoryWrites } : {}),
            leaseMs, now: new Date(clock.now()),
          });
          messages.push(toolResultMessage(tool.name, output));
        }
        continue;
      }

      // No tool calls + natural stop → a TASK mission is complete. Standing
      // missions keep going until the leg cap (heartbeat-shaped by design).
      if (opts.spec.mission.kind === 'task' && result.finishReason === 'stop') {
        // Step 8: TOOL-BEARING runs end with ONE deliberate tool-free call
        // — the wrap-up — served under brain.policy and stamped 'brain'
        // (the toolPolicy activation; Step 7's exit criterion). Its text
        // is report material. Toolless runs already ended on a brain call.
        if (toolDefs && estSpentUsd < opts.spec.fuel.maxUsdPerRun) {
          // The wrap-up is a PAID call — it rides only when fuel remains
          // (review finding: no serving call after the cap, not even the
          // deliberate one; the report already tolerates a missing wrap-up).
          messages.push(wrapUpMessage());
          const wrapPayload = { model: 'potion-auto', messages: [...messages] };
          let wrap = await opts.client.complete({
            messages,
            ...(opts.policyRefs?.brain !== undefined ? { policyRef: opts.policyRefs.brain } : {}),
          });
          for (let retry = 0; wrap.kind === 'rate-limited' && retry < (opts.rateRetries ?? 3); retry++) {
            await sleep(wrap.retryAfterMs);
            wrap = await opts.client.complete({
              messages,
              ...(opts.policyRefs?.brain !== undefined ? { policyRef: opts.policyRefs.brain } : {}),
            });
          }
          if (wrap.kind === 'ok') {
            seq += 1;
            await appendLabStep(opts.db, {
              runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'model',
              payload: buildStepPayload({
                ...takeLegStamp(),
                kind: 'model', slot: 'brain', requestPayload: wrapPayload,
                responseText: wrap.text, toolCalls: wrap.toolCalls,
                finishReason: wrap.finishReason, completionId: wrap.completionId,
                frontierTrace: wrap.frontierTrace, usage: wrap.usage,
                clockMs: clock.now(), rngSample: rng(),
              }),
              harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
            });
            stepsThisLeg += 1;
          }
          // A failed wrap-up never blocks completion — the mission is done;
          // the report falls back to the final mission response.
        }
        await fenced.transition('completed');
        return { status: 'completed', steps: stepsThisLeg };
      }
    }

    // Leg cap: release the lease, leave the run adoptable.
    await releaseLabRunLease(opts.db, { runId: opts.runId, orgId: opts.orgId, fence });
    return { status: 'leg-cap', steps: stepsThisLeg };
  } catch (e) {
    if (e instanceof SecretInCheckpointError) {
      await fenced.transition('failed', `secret-in-checkpoint: ${e.message}`).catch(() => {});
      return { status: 'failed', reason: 'secret-in-checkpoint', steps: 0 };
    }
    throw e;
  }
}

function isMemoryCarrier(v: unknown): v is { _memoryWrites: Record<string, unknown> } {
  return (
    v !== null &&
    typeof v === 'object' &&
    '_memoryWrites' in v &&
    typeof (v as { _memoryWrites: unknown })._memoryWrites === 'object'
  );
}
