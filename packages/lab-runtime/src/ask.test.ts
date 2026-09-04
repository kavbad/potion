// ask_operator — the worker→operator question channel (2026-08-31).
// Born from a LIVE failure: a browser worker missing its one input (the URL)
// asked for it in a FINAL MESSAGE and then "completed", filing a meta-summary
// as its result. The honest move is to PARK and ask. Laws:
//   · an ask parks the run awaiting-human with the question, spending nothing
//     more — the check-in step carries trigger 'worker-question';
//   · the operator's answer resumes the leg as the next message, and the run
//     then finishes on real work;
//   · an answer to a QUESTION never authorizes an external ACTION — the next
//     external call still hits the pore;
//   · calls bundled AFTER the ask in the same response are dropped (the park
//     wins);
//   · the whole record replays divergence-free (the mirror).
import { describe, expect, it } from 'vitest';
import {
  answerLabRun,
  createDb,
  createLabRun,
  getLabRun,
  listLabSteps,
  migrate,
  seedIsolationOrgs,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, type HarnessSpec } from '@potion/lab-spec';
import { runLeg, type LabTool } from './loop.js';
import { replayRun, type RecordedStep, type RecordedTerminal } from './replay.js';
import type { ServingClient, ServingRequest, ServingResult } from './serving-client.js';

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'ask test harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'open the app I link and do the task', doneDefinition: 'the task is done' },
    superpowers: [],
    memory: { enabled: true },
    rules: ['be terse'],
    fuel: { maxUsdPerRun: 1, hardStop: true },
    checkIns: [],
    ...over,
  };
}

function scripted(results: ServingResult[]): ServingClient & { calls: ServingRequest[] } {
  const queue = [...results];
  const calls: ServingRequest[] = [];
  return {
    calls,
    complete: async (req: ServingRequest) => {
      calls.push(req);
      const next = queue.shift();
      if (!next) throw new Error('scripted client exhausted');
      return next;
    },
    emitSpans: async () => true,
  } as unknown as ServingClient & { calls: ServingRequest[] };
}

function ok(over: Partial<Extract<ServingResult, { kind: 'ok' }>> = {}): ServingResult {
  return {
    kind: 'ok',
    completionId: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    text: 'done.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    frontierTrace: 'cluster=code-gen;strategy=test;frontier=v1;policy=min_cost;fallback=0;provenance=mock',
    ...over,
  };
}

async function freshRun(s: HarnessSpec): Promise<{ h: DbHandle; hash: string }> {
  const h = await createDb();
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  const hash = harnessSpecHash(s);
  await createLabRun(h.db, { id: 'run-ask', orgId: ORG_A, harnessHash: hash, harnessName: s.name, spec: s });
  return { h, hash };
}

const ORG = ORG_A;

function askCall(question: string): { id: string; type: 'function'; function: { name: string; arguments: string } } {
  return { id: 'ask1', type: 'function', function: { name: 'ask_operator', arguments: JSON.stringify({ question }) } };
}

async function recordOf(h: DbHandle): Promise<{ steps: RecordedStep[]; terminal: RecordedTerminal }> {
  const rows = await listLabSteps(h.db, 'run-ask', ORG);
  const run = (await getLabRun(h.db, 'run-ask', ORG))!;
  return {
    steps: rows.map((r) => ({ seq: r.seq, kind: r.kind, payload: r.payload })) as RecordedStep[],
    terminal: { state: run.state } as RecordedTerminal,
  };
}

describe('ask_operator parks the run and asks — never a hollow completion', () => {
  it('the ask parks awaiting-human with the question; the answer resumes and the run finishes on real work; the record replays clean', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    let noted: unknown = null;
    const noteTool: LabTool = {
      name: 'record_note', description: 'record a note', parameters: { type: 'object' },
      external: false,
      run: async (input) => { noted = input; return { noted: true }; },
    };

    const leg1 = await runLeg({
      db: h.db, client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [askCall('What URL should I open?')] }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [noteTool],
    });
    expect(leg1.status).toBe('awaiting-human');
    if (leg1.status === 'awaiting-human') expect(leg1.question).toBe('What URL should I open?');
    const parked = (await getLabRun(h.db, 'run-ask', ORG))!;
    expect(parked.state).toBe('awaiting-human');
    expect(parked.pendingQuestion).toBe('What URL should I open?');
    const checkIn = (await listLabSteps(h.db, 'run-ask', ORG)).find((x) => x.kind === 'check-in');
    expect(checkIn).toBeDefined();
    expect((checkIn!.payload as { checkInTrigger?: string }).checkInTrigger).toBe('worker-question');

    // The operator answers; the resumed leg sees the answer as its next
    // message and finishes on real work.
    expect(await answerLabRun(h.db, 'run-ask', ORG, 'https://board.example/sprint-12')).toBe(true);
    const second = scripted([
      ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'n1', type: 'function', function: { name: 'record_note', arguments: '{"url":"https://board.example/sprint-12"}' } }] }),
      ok({ text: 'Opened the board and finished the task at https://board.example/sprint-12. done.' }),
      ok({ text: 'Wrap-up: asked for the URL, got it, did the work; done.' }),
    ]);
    const leg2 = await runLeg({
      db: h.db, client: second, runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [noteTool],
    });
    expect(leg2.status).toBe('completed');
    expect(noted).toEqual({ url: 'https://board.example/sprint-12' });
    // The answer rode the conversation into the resumed leg.
    const firstResume = second.calls[0]!;
    expect(JSON.stringify(firstResume.messages)).toContain('https://board.example/sprint-12');

    // THE MIRROR: the full record replays divergence-free.
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('an answer to a QUESTION never authorizes an ACTION — the next external call still hits the pore', async () => {
    const s = spec({ checkIns: [{ trigger: 'before-external-action' }] });
    const { h, hash } = await freshRun(s);
    let sent = 0;
    const emailTool: LabTool = {
      name: 'send_email', description: 'send an email', parameters: { type: 'object' },
      external: true,
      run: async () => { sent += 1; return { sent: true }; },
    };

    const leg1 = await runLeg({
      db: h.db, client: scripted([ok({ text: '', finishReason: 'tool_calls', toolCalls: [askCall('Who is the recipient?')] })]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool],
    });
    expect(leg1.status).toBe('awaiting-human');

    await answerLabRun(h.db, 'run-ask', ORG, 'send it to ops@example.com');
    const leg2 = await runLeg({
      db: h.db, client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'e1', type: 'function', function: { name: 'send_email', arguments: '{"to":"ops@example.com"}' } }] }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [emailTool],
    });
    // The pore parks AGAIN — the question's answer approved nothing.
    expect(leg2.status).toBe('awaiting-human');
    expect(sent, 'the external act must not ride a question answer').toBe(0);
    await h.close();
  }, 60_000);

  it('THE UNFILLED-SLOT LAW: a prose stop on a slotted goal parks as the question instead of completing; the answered run completes; replay agrees', async () => {
    const s = spec({
      mission: {
        kind: 'task',
        goal: 'Open [PASTE THE APP URL HERE] in the real browser and do this task: [DESCRIBE THE TASK HERE].',
        doneDefinition: 'the task is done in the app',
      },
    });
    const { h, hash } = await freshRun(s);
    // The model answers in PROSE asking for the details — exactly the live
    // failure. The loop must refuse the completion and park with this text.
    const prose = 'I need the actual mission details: the URL to open and the task to perform. Could you provide them?';
    const leg1 = await runLeg({
      db: h.db, client: scripted([ok({ text: prose })]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [],
    });
    expect(leg1.status).toBe('awaiting-human');
    if (leg1.status === 'awaiting-human') expect(leg1.question).toBe(prose);
    expect((await getLabRun(h.db, 'run-ask', ORG))!.state).toBe('awaiting-human');

    // The answer arrives; the goal STILL carries its slots (specs are
    // frozen) — the one-ask-per-run guard lets the resumed run complete.
    await answerLabRun(h.db, 'run-ask', ORG, 'https://board.example — file one card titled "hello"');
    const leg2 = await runLeg({
      db: h.db, client: scripted([
        ok({ text: 'Filed the card titled "hello" on https://board.example; the board shows it at the top. done.' }),
        ok({ text: 'Wrap-up: asked for the mission details, received them, filed the card; done.' }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [],
    });
    expect(leg2.status).toBe('completed');
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it("a helper (askChannel 'none') gets the typed refusal, not a park — and its record replays clean", async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    const leg = await runLeg({
      db: h.db, client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [askCall('Which board?')] }),
        ok({ text: 'No operator channel exists; proceeding with my best result: the mission lacked a board name, so I report that gap plainly.' }),
        ok({ text: 'Wrap-up: could not ask; reported the gap; done.' }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [], askChannel: 'none',
    });
    expect(leg.status).toBe('completed');
    const steps = await listLabSteps(h.db, 'run-ask', ORG);
    expect(steps.some((x) => x.kind === 'check-in')).toBe(false);
    const askStep = steps.find((x) => x.kind === 'tool');
    expect(askStep).toBeDefined();
    expect(JSON.stringify(askStep!.payload)).toContain('no operator channel');
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('calls bundled after the ask are dropped — the park wins; replay agrees', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    let ran = 0;
    const noteTool: LabTool = {
      name: 'record_note', description: 'record a note', parameters: { type: 'object' },
      external: false,
      run: async () => { ran += 1; return { noted: true }; },
    };
    const leg1 = await runLeg({
      db: h.db, client: scripted([
        ok({
          text: '', finishReason: 'tool_calls',
          toolCalls: [askCall('Which board?'), { id: 'n1', type: 'function', function: { name: 'record_note', arguments: '{}' } }],
        }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [noteTool],
    });
    expect(leg1.status).toBe('awaiting-human');
    expect(ran, 'the bundled call after the ask must not run').toBe(0);
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);
});

describe('W3 correction — the slot law fires only on WORK-FREE stops', () => {
  it('a slotted-goal run that did real tool work completes on its report — the report is not a question', async () => {
    const s = spec({
      mission: { kind: 'task', goal: 'Open [PASTE THE APP URL HERE] and do this task: [DESCRIBE THE TASK HERE].', doneDefinition: 'done' },
      rules: ['Standing answer from the operator (do not ask again): open https://board.example and report the title'],
    });
    const { h, hash } = await freshRun(s);
    let read = 0;
    const readTool: LabTool = {
      name: 'open_page', description: 'open a page', parameters: { type: 'object' },
      external: false,
      run: async () => { read += 1; return { title: 'Board — Sprint 12' }; },
    };
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: '', finishReason: 'tool_calls', toolCalls: [{ id: 'o1', type: 'function', function: { name: 'open_page', arguments: '{"url":"https://board.example"}' } }] }),
        ok({ text: 'Opened https://board.example — the page title is "Board — Sprint 12". Mission complete.' }),
        ok({ text: 'Wrap-up: used the standing answer, did the work, reported; done.' }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [readTool],
    });
    expect(leg.status, 'the report must complete, not park').toBe('completed');
    expect(read).toBe(1);
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);
});

// THE QUESTION-STOP LAW (2026-09-04) — from the operator's GTM worker: it
// planned, found real gaps ("I need to know: your business, the lead
// channels, the target volume…"), wrote them into its report and the run
// filed as COMPLETED. The questions sat in a dead transcript with nowhere
// to answer them. A task run that ends by asking the operator for
// information is BLOCKED, not finished.
describe('THE QUESTION-STOP LAW: a stop that asks for input parks, it does not complete', () => {
  const ASKING =
    'I have the mission but a few gaps before I can begin sourcing leads.\n\n' +
    'What I need to know to actually run this:\n' +
    '1. Your business — what you sell and who the ideal customer is?\n' +
    '2. Which lead channels should I use?\n' +
    'Please provide these and I will start the first cycle.';

  it('parks awaiting-human carrying the whole question; the answer resumes and it completes; replay clean', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    const leg1 = await runLeg({
      db: h.db,
      client: scripted([ok({ text: ASKING })]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [],
    });
    expect(leg1.status).toBe('awaiting-human');
    const run = (await getLabRun(h.db, 'run-ask', ORG))!;
    expect(run.state).toBe('awaiting-human');
    // The WHOLE ask is on the record — a half-question cannot be answered.
    expect(run.pendingQuestion).toContain('Which lead channels');
    const steps = await listLabSteps(h.db, 'run-ask', ORG);
    const parked = steps.find((x) => x.kind === 'check-in');
    expect((parked!.payload as { checkInTrigger?: string }).checkInTrigger).toBe('worker-question');

    expect(await answerLabRun(h.db, 'run-ask', ORG, 'We sell B2B analytics to ops leads; use LinkedIn and email.')).toBe(true);
    const leg2 = await runLeg({
      db: h.db,
      client: scripted([
        ok({ text: 'Sourced 12 leads and drafted outreach for each. Done.' }),
        ok({ text: 'Wrap-up: sourced and drafted after the answer.' }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [],
    });
    expect(leg2.status).toBe('completed');
    const rec = await recordOf(h);
    const res = replayRun(s, rec.steps, rec.terminal);
    expect(res.ok, JSON.stringify(!res.ok ? res.divergences : [])).toBe(true);
    await h.close();
  }, 60_000);

  it('a real report that merely contains a question mark still completes — the law reads second-person ASKS, not punctuation', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    const leg = await runLeg({
      db: h.db,
      client: scripted([
        ok({
          text:
            'Analysis complete. Which day drove the most revenue? Saturday, at $1,778.40 across 87 checks — ' +
            'and the answer holds after removing the duplicate order.',
        }),
        ok({ text: 'Wrap-up: the analysis stands.' }),
      ]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [],
    });
    expect(leg.status).toBe('completed');
    const rec = await recordOf(h);
    expect(replayRun(s, rec.steps, rec.terminal).ok).toBe(true);
    await h.close();
  }, 60_000);

  it('once per run: after one park, a second asking stop completes rather than looping', async () => {
    const s = spec();
    const { h, hash } = await freshRun(s);
    await runLeg({
      db: h.db, client: scripted([ok({ text: ASKING })]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [],
    });
    await answerLabRun(h.db, 'run-ask', ORG, 'B2B analytics; LinkedIn and email.');
    const leg2 = await runLeg({
      db: h.db,
      client: scripted([ok({ text: ASKING }), ok({ text: 'Wrap-up: still blocked, reported as such.' })]),
      runId: 'run-ask', orgId: ORG, spec: s, harnessHash: hash, tools: [],
    });
    expect(leg2.status).toBe('completed');
    const rec = await recordOf(h);
    expect(replayRun(s, rec.steps, rec.terminal).ok).toBe(true);
    await h.close();
  }, 60_000);
});
