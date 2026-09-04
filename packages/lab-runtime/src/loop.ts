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
import { canonicalJson, seedFromString, sha256, type ChatMessage, type Tool } from '@potion/core';
import { buildPlanTool, planFromSteps, planLedgerMessage, renderPlanLedger, PLAN_TOOL_NAME } from './plan.js';
import { beatFromMemory, buildBeatTool, emptyBeat, renderBeatLedger, BEAT_PROMPT } from './beat.js';
import { fanOutSpentFromSteps, FANOUT_TOOL_NAME } from './fanout.js';
import { ceilingFor, decideAction, situationSignature, type GateSnapshot } from './gateway.js';
import {
  consumeLabRunAnswer,
  appendLabStep,
  getActionGrantByClass,
  listLabRunFiles,
  claimLabRun,
  getLabMemory,
  transitionLabRun,
  releaseLabRunLease,
  listLabSteps,
  type LabClaim,
  type PotionDb,
} from '@potion/db';
import { BRIEF_CONTRACT_PROMPT, parseBrief, type HarnessSpec } from '@potion/lab-spec';
import { buildStepPayload, SecretInCheckpointError, type StepPayload } from './checkpoint.js';
import type { ServingClient } from './serving-client.js';

export interface LabTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Whether invoking it acts on the world outside the platform — gates the
   * before-external-action check-in. */
  external: boolean;
  /** X2: CORE loop tools (the task ledger) ride every run and never flip
   * the policy slot — a call whose only tools are core still serves under
   * brain.policy (planning is thinking; the A2 partition is about real
   * tool serving). */
  core?: boolean;
  /** Human words for the pore's question (2026-08-31, from watching a real
   * approval read "input {\"ref\": \"p8\"}"): a tool that knows what its
   * input MEANS renders it for the person approving — 'click "Add card"
   * (button) on https://…'. Falls back to the raw-input question. The
   * question is record DATA (replay never re-derives it), so this is
   * replay-safe for old records. */
  describeAction?(input: unknown): string | null;
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

/** W0 approval-rendering law (2026-08-31): the fallback pore question for
 * a tool with no describeAction. The old version silently cut arguments at
 * 200 chars — a truncation that can change the meaning of an approval is
 * a lie to the person approving. Truncation is now NAMED, generous, and
 * points at where the full arguments live (the durable record binds the
 * approval to the full fingerprint regardless — checkInAction.argsHash
 * covers the whole payload, never the excerpt). */
export function buildRawPoreQuestion(toolName: string, rawArguments: string): string {
  const shown = JSON.stringify(rawArguments);
  const cut = shown.length > 900;
  return (
    `About to run external tool '${toolName}' with input ${cut ? shown.slice(0, 900) : shown}` +
    (cut ? ` \u2026 [${shown.length - 900} more characters — the full arguments are fingerprint-bound in the run record]` : '') +
    '. Proceed?'
  );
}

export function wrapUpMessage(): ChatMessage {
  return { role: 'user', content: WRAP_UP_PROMPT };
}

/** 2026-09-01 (flagship run-32b24af3): providers default max_tokens near
 * 1k, and a worker WRITING CODE hits it mid-tool-call — the xlsx-building
 * python was truncated at exactly 1024 completion tokens, the call never
 * executed, and the empty follow-up stop read as "task complete". Every
 * mission and wrap-up call now asks for explicit headroom — the FULL
 * serving ceiling (8192): the first 4096 pick truncated a real
 * deliverables-writing call at exactly 4096 tokens (run-28a169d5 seq 44),
 * and there is no downside to asking for the whole ceiling. */
export const MISSION_MAX_TOKENS = 8192;

export function checkInAnswerMessage(answer: string): ChatMessage {
  return { role: 'user', content: `[check-in answer] ${answer}` };
}

/** The exact message shape a tool result becomes (same reasoning). */
export function toolResultMessage(toolName: string, output: unknown): ChatMessage {
  // canonicalJson, NOT JSON.stringify (X2 landmine, found by the ledger's
  // replay test): jsonb round-trips reorder object keys, so a message built
  // from the LIVE output and the same message rebuilt from the RECORDED
  // output could differ in embedded key order — a replay divergence for any
  // tool whose output keys are not jsonb-order-stable. Canonical bytes at
  // both ends kill the class.
  return { role: 'user', content: `[tool ${toolName} result] ${canonicalJson(output ?? null)}` };
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
  /** 'operator' (default): ask_operator parks the run for the operator's
   * answer, and the unfilled-slot law applies. 'none' (helpers): nobody
   * can answer — the ask tool refuses typed and stops complete normally. */
  askChannel?: 'operator' | 'none';
  /** Step 8 per-slot policy pins (the dial's materialized rows): tool-capable
   * calls ride tools ?? brain; tool-free calls (incl. the wrap-up) ride brain. */
  policyRefs?: { brain?: string; tools?: string };
  clock?: Clock;
  /** X8: the steering inlet — read pending operator steers (in order) and
   * mark them consumed with the model-step seq that carried them. Injected
   * by the handler; absent = no steering (tests, CLI, replay). */
  readSteers?: () => Promise<Array<{ id: string; text: string }>>;
  markSteersConsumed?: (ids: string[], seq: number) => Promise<void>;
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
/**
 * The fingerprint of one external action: WHICH tool, with WHICH arguments.
 * The arguments are hashed rather than stored so the identity survives long
 * payloads without duplicating them into a second durable place.
 *
 * Arguments are canonicalised as the raw string the model emitted — the
 * exact bytes the question rendered — so "the same call" means the same
 * call, not an equivalent-looking one.
 */
/**
 * Affirmative consent (L4). The check-in answer is free text a human typed,
 * and the old rule was `answer !== null` — so "no", "stop", "absolutely
 * not" all armed the pore exactly as "yes" did. This recognises approval
 * and nothing else: an answer it does not recognise authorizes NOTHING and
 * the pore fires again, which is the safe direction for a control whose
 * whole job is to stop an action a human did not want.
 */
export function isAffirmative(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  if (t === '') return false;
  // An explicit refusal anywhere in the answer wins outright — "yes, but no"
  // is not consent, and neither is "proceed? no".
  if (/\b(no|nope|don'?t|do not|stop|cancel|deny|denied|refuse|reject|never)\b/.test(t)) return false;
  // "go" is an ordinary way a human approves a check-in — the Step 10
  // walkthrough and the golden corpus both use it — so it belongs here. It
  // is accepted only where it reads as consent on its own ("go", "go
  // ahead", "go on", "go for it"), never as the head of some other
  // instruction, which is why this is not a bare /^go/.
  if (/^go(\s+(ahead|on|for it))?[.! ]*$/.test(t)) return true;
  return /^(y|ye|yes|yep|yeah|ok|okay|sure|approve|approved|proceed|continue|confirm|confirmed|do it|run it)\b/.test(t);
}

/** X8 — the session shape. The exact message an operator steer becomes.
 * Self-carrying (no system-prompt change, so every old record replays
 * byte-identically): guidance, never authorization — the pore's answer
 * channel remains the ONLY thing that authorizes an external action. */
export function steerMessage(text: string): { role: 'user'; content: string } {
  return {
    role: 'user',
    content:
      `Operator steering (mid-run): ${text}\n` +
      `Fold this into the work in progress — it is guidance from the human, not a new mission and not an approval of any pending action.`,
  };
}

/** The worker→operator question channel (2026-08-31 — found live: a
 * worker missing its inputs asked for them in a FINAL MESSAGE and then
 * "completed"; the honest move is to PARK and ask). ask_operator rides the
 * same awaiting-human machinery as every check-in: the run pauses, the
 * operator is notified, their answer resumes the leg as the next message.
 * It can never authorize an external action — the consumption law keys on
 * the before-external-action trigger, and this one carries no action. */
export const ASK_TOOL_NAME = 'ask_operator';

/** An authored input slot the operator never filled — [PASTE THE APP URL
 * HERE] and kin (two+ ALL-CAPS words in brackets). A mission still carrying
 * one is not yet specified: the unfilled-slot law refuses to let a no-tool
 * stop complete it and converts that stop into the ask the model should
 * have made. */
export function hasUnfilledSlot(goal: string): boolean {
  return /\[[A-Z][A-Z0-9./-]* [A-Z0-9 ./-]{2,56}\]/.test(goal);
}

export function buildAskTool(): LabTool {
  return {
    name: ASK_TOOL_NAME,
    description:
      'Ask the operator ONE clarifying question when the mission is missing information you genuinely need (a URL, a file, a concrete choice). ' +
      'The run pauses until they answer; their answer arrives as your next message. Use this INSTEAD of guessing, inventing data, or finishing without doing the work. ' +
      'Never use it to request approval for an external action — external actions ask automatically.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The one question, self-contained and specific.' } },
      required: ['question'],
    },
    external: false,
    core: true,
    // Intercepted by the loop when an operator channel exists; a helper
    // (askChannel 'none') reaches this body and gets the honest refusal.
    run: async (): Promise<unknown> => ({
      error: 'you have no operator channel — you are a delegated helper. Finish with your best result and name plainly what information was missing.',
    }),
  };
}

export function actionFingerprint(
  toolName: string,
  rawArguments: string,
): { toolName: string; argsHash: string; arguments: string } {
  return { toolName, argsHash: sha256(rawArguments), arguments: rawArguments };
}

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
  // P3: a beat-bearing spec renders its working set READABLY (entities with
  // history, source stats, dedup count, the worker's own notes) and any
  // non-beat keys as the classic blob; non-beat specs stay byte-identical.
  const beatOn = spec.memory.beat === true;
  const plainKeys = beatOn ? Object.keys(memory).filter((k) => !k.startsWith('beat:')).sort() : Object.keys(memory).sort();
  const plain = Object.fromEntries(plainKeys.map((k) => [k, memory[k]]));
  const beatLedger = beatOn ? renderBeatLedger(memory) : '';
  const mem =
    (beatLedger !== '' ? `\nYour working set (durable across checks):\n${beatLedger}` : '') +
    (plainKeys.length > 0 ? `\nMemory:\n${JSON.stringify(plain, plainKeys)}` : '');
  const beatLaw = beatOn && spec.mission.kind === 'standing' ? `\n${BEAT_PROMPT}` : '';
  // X4: the fan-out law — gated on the NEW fanOut field (replay law).
  const fanOutLaw =
    spec.fanOut !== undefined
      ? `\nYou can split big work across up to ${spec.fanOut.maxWorkers} helpers with the delegate tool. Each helper is a full worker running under a slice of YOUR remaining budget (a reserve is kept for your synthesis) — helpers think, read the web, and run code when those powers are enabled, and cannot take external actions or delegate further. A failed or budget-killed helper is reported to you honestly: work with what returned and name the gaps.`
      : '';
  // P5: the watchdog law — gated on the NEW shape field, so reporter and
  // pre-P5 prompts stay byte-identical and old records replay clean.
  const shapeLaw =
    spec.mission.kind === 'standing' && spec.mission.shape === 'watchdog'
      ? `\nYou are a WATCHDOG: most checks should end quietly. Fire only when the condition truly holds, and every alert must carry its evidence (the diff, the line, the number, with its source). When nothing warrants attention, the quiet report IS the deliverable: say nothing needs them, state how many sources you checked and what you verified. A false alarm is a failure; a missed true change is a worse one.`
      : '';
  const guidance =
    toolGuidance.length > 0 ? `\nYour connected superpowers:\n${toolGuidance.map((g) => `- ${g}`).join('\n')}` : '';
  // P1 contract (the mouth): contract-bearing specs get the deliverable
  // instructions; contract-less prompts stay byte-identical (A2 discipline).
  const contract = spec.contract !== undefined ? `\n${BRIEF_CONTRACT_PROMPT}` : '';
  // C-3: the operator's exemplar — the standard to hit, in the worker's
  // context on every call (exemplar-less prompts stay byte-identical).
  const exemplar =
    spec.exemplar !== undefined
      ? `\nA great result looks like (the standard to hit):\n${spec.exemplar}`
      : '';
  return `You are a harness named '${spec.name}'.\n${mission}${rules}${mem}${guidance}${beatLaw}${shapeLaw}${fanOutLaw}${contract}${exemplar}\nMaintain a task ledger with ${PLAN_TOOL_NAME}: for multi-step work, file the plan first and update statuses as you go — the ledger survives interruptions and is re-shown to you when work resumes.\nWhen the mission is complete, answer normally with no tool calls.`;
}

/** P1 contract law — the repair prompt. A pure function of the parse issues
 * so live and replay derive IDENTICAL messages from the same recorded
 * response text. The prefix is the counter: the loop counts repair messages
 * in the conversation (rebuilt from durable steps on resume), never in
 * transient state. */
/** THE FILE-CLAIMS LAW (2026-09-01, from the flagship's resurrected run):
 * a completion whose report NAMES workspace files the run does not hold is
 * a caption claiming provenance it lacks — the model computed everything,
 * got stranded before the write, resumed, and simply asserted the files
 * existed. One deterministic repair round: produce them or correct the
 * report. Pure over the text + the actual file listing. */
export function missingClaimedFiles(text: string, existing: readonly string[]): string[] {
  const claimed = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./-]{0,80}\.(?:xlsx|csv|png|jpg|pdf|md|json|txt|zip|html)\b/g)) {
    claimed.add(m[0].replace(/^\.\//, ''));
  }
  const have = new Set(existing.map((n) => n.toLowerCase()));
  const haveBase = new Set(existing.map((n) => n.split('/').pop()!.toLowerCase()));
  return [...claimed]
    .filter((c) => {
      const lower = c.toLowerCase();
      const base = lower.split('/').pop()!;
      return !have.has(lower) && !have.has(base) && !haveBase.has(base);
    })
    .slice(0, 8);
}

/** THE DONE-DEFINITION LAW (2026-09-03, run-8a3ec460 and the F4 rehearsal,
 * where it cost two of four draft attempts): the file-claims law reads the
 * REPORT for filenames, so a run that stops mid-thought — "Now let me read
 * both fully" — names no file, claims nothing, and completes with its
 * deliverable missing. But the mission's OWN done-definition is a standing
 * claim: when it names a deliverable file and the run does not hold that
 * file, the task is not done, whatever the text says. One repair round per
 * run, stamped before recording, replay-mirrored. */
export const DONE_FILE_REPAIR_PREFIX = 'Your done-definition requires files this run does not hold:';

export function doneFileRepairMessage(missing: readonly string[]): ChatMessage {
  return {
    role: 'user',
    content: `${DONE_FILE_REPAIR_PREFIX} ${missing.join(', ')}. The task is not complete until they exist in the working directory (only files written there persist). Produce them now, then report. If you cannot, say exactly what stopped you — never stop mid-thought.`,
  };
}

/** THE EMPTY-STOP LAW (2026-09-01, runs 32b24af3 + 4638e4a1): twice in one
 * day a cheap route returned a ZERO-TOKEN stop mid-mission and the grammar
 * read it as "task complete" — no report, so no judge (extractReport needs
 * ≥40 chars), so a 'completed' run with zero payoff. A task stop whose text
 * cannot even BE a report (under extractReport's own 40-char bar) is not a
 * completion: one stamped repair round per run, replay-mirrored, then the
 * grammar proceeds however the model answers. */
export const EMPTY_STOP_REPAIR_MESSAGE =
  'You stopped without a report. A task run must end with the work DONE and a report of what was produced — finish the mission now (run the tools, write the files), or state honestly what you completed and what you could not.';
export function emptyStopRepairMessage(): ChatMessage {
  return { role: 'user', content: EMPTY_STOP_REPAIR_MESSAGE };
}

export const FILE_CLAIM_REPAIR_PREFIX = 'Your report names files that do NOT exist in this run:';
export function fileClaimRepairMessage(missing: readonly string[]): ChatMessage {
  return {
    role: 'user',
    content: `${FILE_CLAIM_REPAIR_PREFIX} ${missing.join(', ')}. Either actually produce them now (write them in the sandbox — only files in the working directory persist) or correct the report to describe only what truly exists. Never claim a deliverable the run does not hold.`,
  };
}

export const CONTRACT_REPAIR_PREFIX = 'Contract violation — your reply was not a valid deliverable.';
export function contractRepairMessage(issues: string[]): ChatMessage {
  return {
    role: 'user',
    content: `${CONTRACT_REPAIR_PREFIX} Issues: ${issues.join('; ')}. Reply with ONLY the corrected JSON deliverable — no prose.`,
  };
}
/** Repairs already spent in this conversation — derived from the messages
 * themselves so leg resume and replay count identically. */
export function contractRepairsIn(messages: ChatMessage[]): number {
  return messages.filter(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(CONTRACT_REPAIR_PREFIX),
  ).length;
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
  // X2: the task ledger's update_plan is a CORE tool on EVERY run — no
  // grant (planning is thinking). Consequence, deliberate: every task run
  // is now tool-bearing, so every task run ends with the wrap-up call.
  // P3: beat-bearing standing specs also carry `remember` (core — memory
  // is thinking too). Its state ref is seeded from this leg's memory read
  // below; within-leg calls accumulate through the ref.
  const beatOn = opts.spec.memory.enabled && opts.spec.memory.beat === true && opts.spec.mission.kind === 'standing';
  const beatRef = { current: emptyBeat() };
  const tools = [
    ...(opts.tools ?? []),
    buildPlanTool(),
    buildAskTool(),
    ...(beatOn
      ? [buildBeatTool({ state: beatRef, today: () => new Date(clock.now()).toISOString().slice(0, 10) })]
      : []),
  ];
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
    // One honest ask per run for unfilled-slot missions (the spec is frozen,
    // so the slot never leaves the goal — without this guard the answered
    // run could never complete).
    // W3 correction (predicted, then confirmed on the first shadow
    // rehearsal): the slot law exists to catch a PROSE ASK IN LIEU OF
    // WORK. A run that did real tool work and then stopped is REPORTING,
    // not asking — converting its report into a question parks a finished
    // mission. The law fires only on work-free stops.
    let sawToolStep = priorSteps.some((x) => x.kind === 'tool');
    let fileClaimFiredThisLeg = false;
    let doneFileFiredThisLeg = false;
    let emptyStopFiredThisLeg = false;
    const askedBefore = priorSteps.some(
      (x) => x.kind === 'check-in' && (x.payload as StepPayload).checkInTrigger === 'worker-question',
    );
    const memory = await getLabMemory(opts.db, opts.orgId, opts.harnessHash);
    if (beatOn) beatRef.current = beatFromMemory(memory);
    let messages: ChatMessage[];
    if (priorSteps.length === 0) {
      messages = [
        { role: 'system', content: systemPrompt(opts.spec, memory, opts.toolGuidance ?? []) },
        { role: 'user', content: 'Begin the mission.' },
      ];
    } else {
      messages = conversationFromSteps(priorSteps);
      // X2: the durable ledger, re-shown at every leg boundary — this is
      // what kills leg amnesia. Derived from the record, injected as ONE
      // recorded message, stamped on the leg's first step (the check-in
      // answer precedent) so replay derives the identical conversation.
      // Order is LEDGER then ANSWER: the human's answer stays the most
      // immediate context.
      const ledgerTasks = planFromSteps(priorSteps);
      if (ledgerTasks !== null && ledgerTasks.length > 0) {
        messages.push(planLedgerMessage(renderPlanLedger(ledgerTasks)));
      }
      if (claim.pendingAnswer !== null) {
        messages.push(checkInAnswerMessage(claim.pendingAnswer));
      }
    }

    // Per-run fuel accounting: estimates from checkpointed usage. Labeled an
    // estimate everywhere; the completionId join to request_logs is truth.
    // The spend ledger: metered truth (costUsd) where money actually moved;
    // the token estimate as the ACTIVITY bound where it did not ($0 routes,
    // old steps) — a free route must not unbound a runaway loop.
    let estSpentUsd = priorSteps.reduce(
      (acc, s) => {
        const sp = s.payload as StepPayload;
        return acc + (sp.costUsd !== undefined && sp.costUsd > 0 ? sp.costUsd : (sp.estCostUsd ?? 0));
      },
      0,
    );
    // X4 (one fuel tree): helper spend recorded in delegate outputs counts
    // against THIS run's cap — derived from the record, mirrored in replay.
    estSpentUsd += fanOutSpentFromSteps(priorSteps);
    // A recorded check-in answer AUTHORIZES the next external action, once —
    // but ONLY when the question it answered WAS the external-action gate
    // (review finding: a fuel check-in's "keep going" must never authorize
    // an external action the human was not shown). Without consumption
    // semantics the resumed leg would re-ask on the very tool call the
    // human just approved — an infinite politeness loop.
    const lastCheckIn = [...priorSteps].reverse().find((s) => s.kind === 'check-in');
    const lastCheckInPayload = lastCheckIn?.payload as StepPayload | undefined;
    // Step 12 findings L2/L3/L4 — three CRITICAL defects met in one place,
    // because they were three faces of the same mistake: treating "an answer
    // exists" as "this action is approved".
    //
    //   L2  the authorization was bound to the check-in's TRIGGER TYPE, so a
    //       DIFFERENT act consumed the approval the human gave for another.
    //       → it is now bound to the action's fingerprint (tool + arguments).
    //   L4  ANY answer armed it, including "no". A refusal authorized the
    //       action it refused. → affirmative consent is now required, and
    //       anything not recognised as affirmative authorizes nothing.
    //   L3  consumption was an in-memory boolean while the durable
    //       pending_answer survived the leg-cap exit, so one "yes" re-armed
    //       the pore on every following leg. → consumption CLEARS the
    //       durable answer, at the moment of use.
    //
    // All three fail closed: an unparseable answer, a missing fingerprint,
    // or a mismatched call all mean "not authorized", never "authorized".
    let authorizedAction: { toolName: string; argsHash: string; arguments: string } | null =
      claim.pendingAnswer !== null &&
      isAffirmative(claim.pendingAnswer) &&
      lastCheckInPayload?.checkInTrigger === 'before-external-action' &&
      lastCheckInPayload.checkInAction !== undefined
        ? lastCheckInPayload.checkInAction
        : null;
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
    // X2: the leg stamp records EVERYTHING this leg start injected — the
    // ledger text and/or the check-in answer — so the record stays
    // self-contained and replay derives the same messages in the same
    // order (ledger, then answer).
    const injectedLedger =
      priorSteps.length === 0
        ? null
        : (() => {
            const t = planFromSteps(priorSteps);
            return t !== null && t.length > 0 ? renderPlanLedger(t) : null;
          })();
    let legStamp: Partial<StepPayload> | null =
      priorSteps.length === 0
        ? { memoryReads: memory, toolGuidance: [...(opts.toolGuidance ?? [])] }
        : injectedLedger !== null || claim.pendingAnswer !== null
          ? {
              ...(injectedLedger !== null ? { planLedger: injectedLedger } : {}),
              ...(claim.pendingAnswer !== null ? { checkInAnswer: claim.pendingAnswer } : {}),
            }
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

    // ---- HONEST START (2026-08-31): a worker BORN TOOLLESS does not flail.
    // If it declared superpowers but NONE loaded (every declared power came
    // back as a superpowerUnavailable leg note), it cannot do its job — so
    // it fails fast with a crisp, ACTIONABLE reason instead of producing
    // prose that pretends to work and then "completes" hollow. A truly
    // brain-only worker declares no superpowers and is untouched; a worker
    // with even one connected power is left to do its partial work.
    // Recomputed each leg from the handler's fresh notes.
    if (opts.spec.superpowers.length > 0) {
      const realToolLoaded = (opts.tools ?? []).some((t) => t.core !== true);
      const unavailable = (opts.legNotes ?? [])
        .map((n) => (n.note as { superpowerUnavailable?: { connectorId?: string; detail?: string } } | null)?.superpowerUnavailable)
        .filter((x): x is { connectorId?: string; detail?: string } => x !== undefined && x !== null);
      if (!realToolLoaded && unavailable.length > 0) {
        // The reason carries each power's OWN remediation (connect vs a
        // deployment gap) so it is always actionable, never generic.
        const parts = unavailable.map((u) => `${u.connectorId ?? 'a superpower'}${u.detail !== undefined ? ` (${u.detail})` : ''}`);
        const reason = `not ready: this worker needs ${[...new Set(parts)].join('; ')} before it can work. Fix that, then run again — it will not spend a cent flailing without its tools.`;
        await fenced.transition('failed', reason);
        return { status: 'failed', reason: 'superpowers-unconnected', steps: 0 };
      }
    }

    // ---- the APPROVED action runs; the model is not asked to re-propose ----
    //
    // Step 12 (L2, second half). Binding the approval to a fingerprint is
    // only half the property. The other half surfaced when the walkthrough
    // started re-asking forever: on resume the conversation now CONTAINS the
    // approval, so the model's next proposal differs — different arguments,
    // sometimes a different tool — and a fingerprint match would essentially
    // never happen. An operator facing an endless re-ask turns the check-in
    // off, which is worse than no gate at all.
    //
    // So the resumed leg does not ask the model what to do next: it EXECUTES
    // THE CALL THE HUMAN READ, byte for byte, out of the check-in record.
    // What was approved is what runs — which is both the safer rule and the
    // one a person would assume was already true.
    if (authorizedAction !== null) {
      const approved = authorizedAction;
      const tool = tools.find((t) => t.name === approved.toolName);
      if (tool === undefined) {
        // The approved tool is not loaded this leg (a grant revoked between
        // the question and the answer, say). Fail closed: nothing runs, and
        // the authorization is burned so it cannot be spent later.
        await consumeLabRunAnswer(opts.db, opts.runId, opts.orgId);
        authorizedAction = null;
      } else {
        const input: unknown = JSON.parse(approved.arguments || '{}');
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
          ...(isMemoryCarrier(output) ? { memoryWrites: output._memoryWrites } : {}),
          leaseMs, now: new Date(clock.now()),
        });
        sawToolStep = true;
        messages.push(toolResultMessage(tool.name, output));
        // Consumed — one answer, THAT one action, once. The durable clear is
        // what makes "once" survive a leg boundary (L3): the in-memory null
        // alone died with the leg and left the row armed.
        authorizedAction = null;
        await consumeLabRunAnswer(opts.db, opts.runId, opts.orgId);
      }
    }

    let stepsThisLeg = 0;
    // 2026-08-27 stall breaker: the previous NO-TOOL response text — two
    // identical answers in a row mean the loop is feeding the model its own
    // echo, and every further call burns money for nothing.
    let lastResponseText: string | null = null;
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

      // ---- X8: live steering — pending operator guidance folds in HERE,
      // at the step boundary, recorded ON the model step it precedes so
      // replay derives the identical conversation. Consumption is durable
      // (a crash between append and mark re-delivers — a duplicate note is
      // the safe direction; a lost one is not).
      let steerTexts: string[] | undefined;
      let steerIds: string[] = [];
      if (opts.readSteers !== undefined) {
        const pending = await opts.readSteers();
        if (pending.length > 0) {
          steerTexts = pending.map((x) => x.text);
          steerIds = pending.map((x) => x.id);
          for (const t of steerTexts) messages.push(steerMessage(t));
        }
      }

      // ---- model step (with bounded rate-limit retry) ----
      // X2: core tools never flip the slot — a call whose only tools are
      // the ledger still serves under brain.policy (the A2 partition is
      // about REAL tool serving).
      const hasExternalTools = tools.some((t) => t.core !== true);
      const slot: 'brain' | 'tools' = toolDefs && hasExternalTools ? 'tools' : 'brain';
      const slotRef = slot === 'tools'
        ? (opts.policyRefs?.tools ?? opts.policyRefs?.brain)
        : opts.policyRefs?.brain;
      const requestPayload = { model: 'potion-auto', messages: [...messages], ...(toolDefs ? { tools: toolDefs } : {}) };
      let result = await opts.client.complete({ messages, maxTokens: MISSION_MAX_TOKENS, ...(toolDefs ? { tools: toolDefs } : {}), ...(slotRef !== undefined ? { policyRef: slotRef } : {}) });
      for (let retry = 0; result.kind === 'rate-limited' && retry < (opts.rateRetries ?? 3); retry++) {
        await sleep(result.retryAfterMs);
        result = await opts.client.complete({ messages, maxTokens: MISSION_MAX_TOKENS, ...(toolDefs ? { tools: toolDefs } : {}), ...(slotRef !== undefined ? { policyRef: slotRef } : {}) });
      }
      // RETRY-ON-EMPTY (2026-09-01): one cheap route (41a39732, agentic-
      // tool-use) intermittently returns ZERO-TOKEN stops mid-conversation
      // — four specimens in one day, each derailing a mission at a decision
      // point. A degenerate response is a serving anomaly, not an answer:
      // re-ask up to twice, same request, unrecorded like rate-limit
      // retries (the recorded step is the final result; replay derives the
      // identical request either way). Still empty after that → the
      // empty-stop law takes it.
      for (
        let retry = 0;
        result.kind === 'ok' && result.toolCalls.length === 0 && result.finishReason === 'stop' && result.text.trim() === '' && retry < 2;
        retry++
      ) {
        result = await opts.client.complete({ messages, maxTokens: MISSION_MAX_TOKENS, ...(toolDefs ? { tools: toolDefs } : {}), ...(slotRef !== undefined ? { policyRef: slotRef } : {}) });
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

      // THE FILE-CLAIMS LAW: a would-be COMPLETION whose text names files
      // the run does not hold gets one repair round. Checked BEFORE the
      // step records so the stamp rides the payload and replay re-derives
      // the non-completion from the record alone. One round per run.
      let fileClaimMissing: string[] = [];
      let doneFileMissing: string[] = [];
      if (opts.spec.mission.kind === 'task' && result.finishReason === 'stop' && result.toolCalls.length === 0) {
        const wantFileClaim =
          (result.text ?? '').trim().length >= 40 &&
          !priorSteps.some((x) => (x.payload as StepPayload).fileClaimRepair !== undefined) &&
          !fileClaimFiredThisLeg;
        // THE DONE-DEFINITION LAW: the mission's own done-definition is a
        // standing file claim — checked at ANY text length, because the
        // hollow case ("Now let me read both fully") names nothing at all.
        const wantDoneFile =
          !priorSteps.some((x) => (x.payload as StepPayload).doneFileRepair !== undefined) && !doneFileFiredThisLeg;
        if (wantFileClaim || wantDoneFile) {
          const names = (await listLabRunFiles(opts.db, opts.orgId, opts.runId)).map((f) => f.name);
          if (wantFileClaim) fileClaimMissing = missingClaimedFiles(result.text ?? '', names);
          if (wantDoneFile) doneFileMissing = missingClaimedFiles(opts.spec.mission.doneDefinition, names);
        }
      }
      // THE EMPTY-STOP LAW: a task stop that says NOTHING cannot be a
      // completion — there is no report, hence no judge, hence a
      // 'completed' run with zero payoff (seen twice live as zero-token
      // stops from a cheap route). One repair round per run, stamped
      // BEFORE recording; the unfilled-slot park outranks it. (Terse
      // non-empty stops still complete — extractReport's 40-char bar is
      // the judge's bar, not the completion bar.)
      let emptyStopRepair = false;
      if (
        opts.spec.mission.kind === 'task' &&
        result.finishReason === 'stop' &&
        result.toolCalls.length === 0 &&
        (result.text ?? '').trim().length === 0 &&
        !((opts.askChannel ?? 'operator') === 'operator' && !askedBefore && !sawToolStep && hasUnfilledSlot(opts.spec.mission.goal)) &&
        !priorSteps.some((x) => (x.payload as StepPayload).emptyStopRepair !== undefined) &&
        !emptyStopFiredThisLeg
      ) {
        emptyStopRepair = true;
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
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(steerTexts !== undefined ? { steers: steerTexts } : {}),
          ...(fileClaimMissing.length > 0 ? { fileClaimRepair: fileClaimMissing } : {}),
          ...(doneFileMissing.length > 0 ? { doneFileRepair: doneFileMissing } : {}),
          ...(emptyStopRepair ? { emptyStopRepair: true } : {}),
        }),
        harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
      });
      if (steerIds.length > 0 && opts.markSteersConsumed !== undefined) {
        await opts.markSteersConsumed(steerIds, seq);
      }
      stepsThisLeg += 1;
      // Cost estimate: usage is real; the price is serving's concern — v1
      // estimates conservatively from tokens at a flat per-1K figure recorded
      // in the payload. The join to request_logs is the auditable number.
      const stepEst = (result.usage.totalTokens / 1000) * 0.01;
      estSpentUsd += result.costUsd !== undefined && result.costUsd > 0 ? result.costUsd : stepEst;
      messages.push({ role: 'assistant', content: result.text });

      if (result.toolCalls.length > 0) {
        for (const call of result.toolCalls) {
          // ask_operator (2026-08-31): the worker parks and ASKS. Recorded
          // as a check-in (trigger worker-question, no action — it can
          // never arm the pore's consumption), then awaiting-human; the
          // answer resumes the leg like any check-in answer. Calls after
          // the ask in the same response are dropped (the park wins) —
          // replay mirrors by clearing its pending set at this step.
          if (call.function.name === ASK_TOOL_NAME && (opts.askChannel ?? 'operator') === 'operator') {
            let q = 'The worker needs more information to continue.';
            try {
              const i = JSON.parse(call.function.arguments || '{}') as { question?: unknown };
              if (typeof i.question === 'string' && i.question.trim() !== '') q = i.question.trim().slice(0, 600);
            } catch { /* malformed args → the generic question */ }
            seq += 1;
            await appendLabStep(opts.db, {
              runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'check-in',
              payload: buildStepPayload({ ...takeLegStamp(), kind: 'check-in', checkInTrigger: 'worker-question', checkInQuestion: q, clockMs: clock.now(), rngSample: rng() }),
              harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
            });
            await fenced.transition('awaiting-human', undefined, q);
            return { status: 'awaiting-human', question: q, steps: stepsThisLeg };
          }
          const tool = tools.find((t) => t.name === call.function.name);
          if (!tool) {
            await fenced.transition('failed', `model called unknown tool '${call.function.name}'`);
            return { status: 'failed', reason: 'unknown-tool', steps: stepsThisLeg };
          }
          // ---- W1: the Action Gateway (before-external-action, one truth) ----
          //
          // Step 12's law stands: there is STILL no "already authorized"
          // branch — one-shot approvals authorize only the exact call a
          // human read (the approved-call execution above). What decides
          // here is the STANDING trust record: the worker's constitution
          // ceiling and its grant for this action class, read FRESH at act
          // time (a tighten written anywhere bites the very next action),
          // fed through the pure decideAction with a recorded rng draw so
          // replay re-derives the decision from the record alone.
          //   hold  → the pore parks, exactly as it always has;
          //   allow → earned autonomy runs, audit-sampled, justification
          //           recorded on the tool step;
          //   block → the call is refused typed; the model continues.
          // Every external call gates — born supervised is the default,
          // no longer conditional on the spec's checkIns list.
          const fingerprint = actionFingerprint(tool.name, call.function.arguments);
          let gatePayload:
            | (GateSnapshot & { decision: 'allow' | 'block'; audit?: boolean; reason?: string; sample: number })
            | undefined;
          if (tool.external) {
            const ceiling = ceilingFor(opts.spec.constitution, tool.name);
            const grantRow = await getActionGrantByClass(opts.db, opts.orgId, opts.harnessHash, tool.name);
            // W2 — distribution membership: the action's param-shape
            // signature vs the demonstrated set materialized on the grant.
            let parsedForSig: unknown = {};
            try { parsedForSig = JSON.parse(call.function.arguments || '{}'); } catch { /* malformed → {} */ }
            const sig = situationSignature(tool.name, parsedForSig);
            const known = (grantRow as { situations?: string[] } | null)?.situations ?? [];
            const snapshot: GateSnapshot = {
              actionClass: tool.name,
              ceiling,
              grantState: grantRow?.state ?? 'none',
              auditRate: grantRow?.auditRate ?? 1,
              situation: sig,
              ...(known.length > 0 ? { knownSituations: known } : {}),
            };
            const sample = rng();
            const gd = decideAction(snapshot, sample);
            if (gd.decision === 'hold') {
              let described: string | null = null;
              try {
                described = tool.describeAction?.(JSON.parse(call.function.arguments || '{}')) ?? null;
              } catch { /* malformed args → raw question */ }
              // An OOD hold on an AUTONOMOUS grant says why it is asking
              // despite earned trust (§6: authority applies only inside
              // the demonstrated region).
              const oodPrefix =
                snapshot.grantState === 'autonomous'
                  ? 'This situation is outside what this worker earned autonomy on. '
                  : '';
              const question = oodPrefix + (described !== null
                ? `It wants to ${described}. Proceed?`
                : buildRawPoreQuestion(tool.name, call.function.arguments));
              seq += 1;
              await appendLabStep(opts.db, {
                runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'check-in',
                payload: buildStepPayload({ ...takeLegStamp(), kind: 'check-in', checkInTrigger: 'before-external-action', checkInQuestion: question, checkInAction: fingerprint, clockMs: clock.now(), rngSample: rng() }),
                harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
              });
              await fenced.transition('awaiting-human', undefined, question);
              return { status: 'awaiting-human', question, steps: stepsThisLeg };
            }
            gatePayload =
              gd.decision === 'allow'
                ? { ...snapshot, decision: 'allow', audit: gd.audit, sample }
                : { ...snapshot, decision: 'block', reason: gd.reason, sample };
          }
          const input: unknown = JSON.parse(call.function.arguments || '{}');
          const output =
            gatePayload?.decision === 'block'
              ? { error: gatePayload.reason ?? 'this action class is barred' }
              : await tool.run(input);
          seq += 1;
          await appendLabStep(opts.db, {
            runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'tool',
            payload: buildStepPayload({
              ...takeLegStamp(),
              kind: 'tool', toolName: tool.name, toolInput: input, toolOutput: output,
              ...(gatePayload !== undefined ? { gate: gatePayload } : {}),
              clockMs: clock.now(), rngSample: rng(),
            }),
            harnessHash: opts.harnessHash,
            // Simple convention v1: a tool may return {_memoryWrites: {...}}
            // to persist harness memory; recorded in the step AND projected.
            ...(isMemoryCarrier(output) ? { memoryWrites: output._memoryWrites } : {}),
            leaseMs, now: new Date(clock.now()),
          });
          // X4: a delegate call's helpers just spent recorded fuel — it
          // counts against the family cap from this moment (mirror: replay
          // adds the same recorded sum at this step).
          if (tool.name === FANOUT_TOOL_NAME) {
            estSpentUsd += fanOutSpentFromSteps([{ kind: 'tool', payload: { toolName: tool.name, toolOutput: output } }]);
          }
          sawToolStep = true;
          messages.push(toolResultMessage(tool.name, output));
        }
        continue;
      }

      // ---- no-tool responses: completion and the stall breaker ----
      if (result.toolCalls.length === 0) {
        // Stall breaker (2026-08-27 prod incident): an identical repeat of
        // the previous answer is the loop echoing — 21 identical thoughts
        // burned a run to its hard stop. Stop, and say what to fix.
        if (lastResponseText !== null && result.text === lastResponseText && result.text.length > 0) {
          const reason =
            'stalled: the worker repeated itself without progress — it likely needs more detail ' +
            'in its mission (what exactly should it act on?). Edit the goal or add a rule, then run again.';
          await fenced.transition('failed', reason);
          return { status: 'failed', reason: 'stalled', steps: stepsThisLeg };
        }
        lastResponseText = result.text;
        // STANDING + natural stop → the CHECK is complete (2026-08-27). The
        // old rule — "keep going until the leg cap, heartbeat-shaped" — made
        // a tool-less standing worker re-ask the model against its own echo
        // until the fuel gate. A standing mission continues across CHECKS,
        // never by spinning one leg's context. The hard stop still wins.
        if (opts.spec.mission.kind === 'standing' && result.finishReason === 'stop') {
          if (estSpentUsd >= opts.spec.fuel.maxUsdPerRun) {
            await fenced.transition('killed-budget', `fuel exhausted: est $${estSpentUsd.toFixed(4)} >= maxUsdPerRun $${opts.spec.fuel.maxUsdPerRun}`);
            return { status: 'killed-budget', reason: 'fuel', steps: stepsThisLeg };
          }
          // P1 contract law (the mouth, 2026-08-28): a contract-bearing
          // check completes ONLY on a parsed, schema-valid deliverable.
          // One repair round (a paid step, counted from the conversation so
          // resume and replay agree), then a typed failure — a check that
          // cannot state its deliverable did not complete, and the run
          // record says so instead of a prose answer masquerading as done.
          // MIRRORED in replay.ts (same commit).
          if (opts.spec.contract !== undefined) {
            const parsedBrief = parseBrief(result.text);
            if (!parsedBrief.ok) {
              if (contractRepairsIn(messages) < 1) {
                messages.push(contractRepairMessage(parsedBrief.issues));
                continue;
              }
              const reason = `contract-violation: the check ended without a valid deliverable (${parsedBrief.issues.join('; ')})`;
              await fenced.transition('failed', reason);
              return { status: 'failed', reason: 'contract-violation', steps: stepsThisLeg };
            }
            // A schema-valid brief can still say NOTHING — headline/byEntity/
            // quiet all empty AND coverage.checked===0 is "I did no work",
            // not a completed check. Treat it like an unparsed brief: one
            // repair round, then an honest failure. (A legitimate quiet
            // watchdog check has coverage.checked>0 and passes.)
            const b = parsedBrief.brief;
            const hollow = b.headline.length === 0 && b.byEntity.length === 0 && b.quiet.length === 0 && b.coverage.checked === 0;
            if (hollow) {
              if (contractRepairsIn(messages) < 1) {
                messages.push(contractRepairMessage(['the deliverable is empty — do the work and report what you found, or state honestly what you checked and why there is nothing (coverage must reflect real checking)']));
                continue;
              }
              await fenced.transition('failed', 'contract-violation: the check produced an empty deliverable — nothing was actually done');
              return { status: 'failed', reason: 'contract-violation', steps: stepsThisLeg };
            }
            await fenced.transition('completed', 'check complete — deliverable filed; the mission rests until its next check');
            return { status: 'completed', steps: stepsThisLeg };
          }
          await fenced.transition('completed', 'check complete — a standing mission rests until its next check');
          return { status: 'completed', steps: stepsThisLeg };
        }
      }

      // No tool calls + natural stop → a TASK mission is complete.
      if (opts.spec.mission.kind === 'task' && result.finishReason === 'stop') {
        // THE FILE-CLAIMS LAW (stamped above): the report names files the
        // run does not hold — one repair round, then honesty either way
        // (the judge scores whatever survives).
        if (fileClaimMissing.length > 0) {
          fileClaimFiredThisLeg = true;
          messages.push(fileClaimRepairMessage(fileClaimMissing));
          continue;
        }
        // THE DONE-DEFINITION LAW (stamped above): the mission's own
        // done-definition names deliverables the run does not hold — one
        // repair round. This is the law the hollow mid-thought stop needs:
        // it claims nothing, so the file-claims law never sees it.
        if (doneFileMissing.length > 0) {
          doneFileFiredThisLeg = true;
          messages.push(doneFileRepairMessage(doneFileMissing));
          continue;
        }
        // THE EMPTY-STOP LAW (stamped above): no report means no completion
        // — one repair round, then the grammar takes whatever comes back.
        if (emptyStopRepair) {
          emptyStopFiredThisLeg = true;
          messages.push(emptyStopRepairMessage());
          continue;
        }
        // THE UNFILLED-SLOT LAW (2026-08-31, from the operator's second
        // failed trial): a goal still carrying an authored input slot is
        // not yet a mission — a no-tool stop on it is almost always the
        // model asking for the inputs in prose, and prose filed as a
        // result is the hollow completion this whole day was about. The
        // stop BECOMES the ask: its text parks the run as the question.
        // Once per run (askedBefore), operator channel only. Mirrored in
        // replay same commit.
        if ((opts.askChannel ?? 'operator') === 'operator' && !askedBefore && !sawToolStep && hasUnfilledSlot(opts.spec.mission.goal)) {
          const q = (result.text ?? '').trim().slice(0, 600)
            || 'The mission has unfilled input slots — what should they be?';
          seq += 1;
          await appendLabStep(opts.db, {
            runId: opts.runId, orgId: opts.orgId, fence, seq, kind: 'check-in',
            payload: buildStepPayload({ ...takeLegStamp(), kind: 'check-in', checkInTrigger: 'worker-question', checkInQuestion: q, clockMs: clock.now(), rngSample: rng() }),
            harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
          });
          await fenced.transition('awaiting-human', undefined, q);
          return { status: 'awaiting-human', question: q, steps: stepsThisLeg };
        }
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
            messages, maxTokens: MISSION_MAX_TOKENS,
            ...(opts.policyRefs?.brain !== undefined ? { policyRef: opts.policyRefs.brain } : {}),
          });
          for (let retry = 0; wrap.kind === 'rate-limited' && retry < (opts.rateRetries ?? 3); retry++) {
            await sleep(wrap.retryAfterMs);
            wrap = await opts.client.complete({
              messages, maxTokens: MISSION_MAX_TOKENS,
              ...(opts.policyRefs?.brain !== undefined ? { policyRef: opts.policyRefs.brain } : {}),
            });
          }
          if (wrap.kind === 'ok') {
            // THE FILE-CLAIMS LAW COVERS THE WRAP-UP (2026-09-01, flagship
            // run-32b24af3): the wrap-up IS the report the customer reads,
            // and it was the only text auditing nothing — a tools-slot stop
            // with EMPTY text slid past the law, then the wrap-up named an
            // analysis.xlsx that never existed and the run still read
            // 'completed'. Same one-round-per-run law, stamped on the wrap
            // step itself; a stamped wrap-up ANNULS the completion attempt
            // and the mission loop continues with the repair message.
            let wrapClaimMissing: string[] = [];
            if (
              !priorSteps.some((x) => (x.payload as StepPayload).fileClaimRepair !== undefined) &&
              !fileClaimFiredThisLeg
            ) {
              const filesAtWrap = await listLabRunFiles(opts.db, opts.orgId, opts.runId);
              wrapClaimMissing = missingClaimedFiles(wrap.text ?? '', filesAtWrap.map((f) => f.name));
            }
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
                ...(wrap.costUsd !== undefined ? { costUsd: wrap.costUsd } : {}),
                ...(wrapClaimMissing.length > 0 ? { fileClaimRepair: wrapClaimMissing } : {}),
              }),
              harnessHash: opts.harnessHash, leaseMs, now: new Date(clock.now()),
            });
            stepsThisLeg += 1;
            if (wrapClaimMissing.length > 0) {
              fileClaimFiredThisLeg = true;
              messages.push({ role: 'assistant', content: wrap.text });
              messages.push(fileClaimRepairMessage(wrapClaimMissing));
              continue;
            }
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
