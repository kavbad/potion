// The clock (F4) — window math and the full state machine over a stubbed
// IO: draft → refuse → redraft → verify → gate hold → operator approval →
// publish, plus the deterministic fallback when attempts exhaust.
import { describe, expect, it } from 'vitest';
import { dailyPieceTick, frontierNotesTick, inTuesdayWindow, isoWeekOf, type ClockIO, type ClockState, type DailyIo } from './clock.js';
import type { FactSheet, Issue } from './types.js';
import type { ObservatoryRun } from '../observatory.js';
import { deterministicDraft } from './write.js';

/** A real (empty-week) observatory run for the given week. The clock only
 *  ever asks "did Monday's measurement land?" and hands the run to
 *  composeFacts, which is stubbed below — but the run it hands over is the
 *  genuine shape, so a change to ObservatoryRun is caught here. */
const observatoryRun = (week: string): ObservatoryRun => ({
  week,
  at: `${week}-at`,
  envelopeBefore: { monthKey: '2026-09', capUsd: 50, mtdUsd: 0, remainingUsd: 50 },
  plan: { canaryClusters: [], canaryBudgetUsd: 0, auditions: 0, auditionBudgetUsd: 0, notes: [] },
  canaries: [],
  auditions: [],
  catalogue: { listings: 0, newSinceRegistry: 0, skippedNoPricing: 0, freeTierExcluded: 0, ranked: 0 },
  spendUsd: 0,
  envelopeAfter: { monthKey: '2026-09', capUsd: 50, mtdUsd: 0, remainingUsd: 50 },
});

const FACTS: FactSheet = {
  week: '2026-W36',
  at: '2026-09-01T00:00:00.000Z',
  frontier: [
    { clusterId: 'code-generation', family: 'code', pick: 'name withheld', storedQuality: 0.981, storedCi95: 0.02, observedMean: 0.983, n: 4, verdict: 'ok' },
  ],
  auditions: [],
  mixing: [],
  numbers: { canaries: 1, clustersHeld: 1, clustersMoved: 0, inconclusive: 0, itemsGraded: 4, candidatesScreened: 3, candidatesMeasured: 0, spendUsd: 0.4 },
  caveats: ['one canary week'],
};

const GOOD_DRAFT = JSON.stringify({
  title: 'Every frontier held this week.',
  summary: 's',
  plain: 'Potion re-checked its scoreboard. Nothing got worse. Nothing changed. All quiet.',
  lede: 'One canary re-checked the code frontier and it held. The margin is 0.020. Nothing moved.',
  frontierNote: 'The routed pick held.',
  auditionNote: 'No new model was suited this week.',
  mixingNote: 'Nothing in the mixing lane beat the best single model.',
  takeaway: 'Routing to the cheapest passing model keeps quality and cost down.',
  faq: [
    { q: 'q1', a: 'a1' },
    { q: 'q2', a: 'a2' },
    { q: 'q3', a: 'a3' },
  ],
});

const PASS_VERDICT = JSON.stringify({ verdict: 'pass', checks: [{ claim: 'held count', method: 'recomputed', ok: true }], requiredChanges: [] });

interface World {
  states: Map<string, ClockState>;
  issues: Map<string, Issue>;
  runs: Map<string, { state: string | null; files: Map<string, string> }>;
  gate: Array<'allow' | 'hold' | 'blocked'>;
  resolutions: Map<string, 'approved' | 'rejected'>;
  outcomes: string[];
  started: string[];
  log: string[];
}

function makeIo(w: World, now: Date, opts: { maxAttempts?: number; noRun?: boolean } = {}): ClockIO {
  let n = 0;
  return {
    now: () => now,
    readObservatoryRun: () => (opts.noRun ? null : observatoryRun(isoWeekOf(now))),
    composeFacts: async () => FACTS,
    readIssue: (week) => w.issues.get(week) ?? null,
    writeIssueFiles: (issue) => void w.issues.set(issue.week, issue),
    readState: (week) => w.states.get(week) ?? null,
    writeState: (s, o) => {
      if (o?.exclusive && w.states.has(s.week)) return false;
      w.states.set(s.week, s);
      return true;
    },
    startWorkerRun: async (harness) => {
      n += 1;
      const id = `run-t${n}-${harness.slice(0, 2)}`;
      w.runs.set(id, { state: null, files: new Map() });
      w.started.push(id);
      return id;
    },
    runTerminalState: async (id) => w.runs.get(id)?.state ?? 'failed',
    readRunFile: async (id, name) => w.runs.get(id)?.files.get(name) ?? null,
    gateAsk: async () => {
      const d = w.gate.shift() ?? 'hold';
      return { decision: d, ...(d === 'allow' ? { audit: false } : { question: 'allow it?' }), gateRunId: 'runx-test' };
    },
    gateResolution: async (_r, actionId) => w.resolutions.get(actionId) ?? null,
    gateOutcome: async (_r, actionId) => void w.outcomes.push(actionId),
    deltaHarness: 'dd'.repeat(32),
    auditorHarness: 'aa'.repeat(32),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
    log: (l) => w.log.push(l),
  };
}

const TUESDAY = new Date('2026-09-01T18:00:00Z'); // Tuesday 11:00 PT

function world(): World {
  return { states: new Map(), issues: new Map(), runs: new Map(), gate: [], resolutions: new Map(), outcomes: [], started: [], log: [] };
}

describe('window math', () => {
  it('isoWeekOf and inTuesdayWindow', () => {
    expect(isoWeekOf(new Date('2026-09-01T12:00:00Z'))).toBe('2026-W36');
    expect(isoWeekOf(new Date('2026-08-31T12:00:00Z'))).toBe('2026-W36');
    expect(inTuesdayWindow(new Date('2026-08-31T18:00:00Z'))).toBe(false); // Monday PT
    expect(inTuesdayWindow(new Date('2026-09-01T12:00:00Z'))).toBe(false); // Tuesday 05:00 PT
    expect(inTuesdayWindow(new Date('2026-09-01T13:30:00Z'))).toBe(true); // Tuesday 06:30 PT
    expect(inTuesdayWindow(new Date('2026-09-03T18:00:00Z'))).toBe(true); // Thursday
  });
});

describe('the state machine', () => {
  it('does nothing outside the window, without a run, or when the week is produced', async () => {
    const w = world();
    expect(await frontierNotesTick(makeIo(w, new Date('2026-08-31T18:00:00Z')))).toBeNull();
    expect(await frontierNotesTick(makeIo(w, TUESDAY, { noRun: true }))).toBeNull();
    w.issues.set('2026-W36', { week: '2026-W36', status: 'published' } as Issue);
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toBeNull();
    expect(w.started).toHaveLength(0);
  });

  it('drives draft → verify → autonomous publish, with the byline and both run ids on the issue', async () => {
    const w = world();
    w.gate.push('allow');
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toMatch(/^delta:/); // starts drafting
    const deltaId = w.started[0]!;
    w.runs.get(deltaId)!.state = 'completed';
    w.runs.get(deltaId)!.files.set('draft.json', GOOD_DRAFT);
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toBe('draft-accepted');
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toMatch(/^auditor:/);
    const auditorId = w.started[1]!;
    w.runs.get(auditorId)!.state = 'completed';
    w.runs.get(auditorId)!.files.set('verdict.json', PASS_VERDICT);
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toBe('published');
    const issue = w.issues.get('2026-W36')!;
    expect(issue.status).toBe('published');
    expect(issue.byline).toBe('Delta');
    expect(issue.writer?.runId).toBe(deltaId);
    expect(issue.writer?.verifiedBy?.runId).toBe(auditorId);
    expect(issue.publishGate?.decision).toBe('allow');
    expect(w.outcomes).toHaveLength(1);
  });

  it('a refused draft redrafts; a failed verification redrafts; a supervised gate holds then releases on the recorded approval', async () => {
    const w = world();
    w.gate.push('hold');
    await frontierNotesTick(makeIo(w, TUESDAY));
    const bad = w.started[0]!;
    w.runs.get(bad)!.state = 'completed';
    w.runs.get(bad)!.files.set('draft.json', JSON.stringify({ ...JSON.parse(GOOD_DRAFT), title: 'Two clusters drifted this week.' }));
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toBe('draft-refused'); // contradicts facts (0 drift)
    await frontierNotesTick(makeIo(w, TUESDAY)); // starts attempt 2
    const good = w.started[1]!;
    w.runs.get(good)!.state = 'completed';
    w.runs.get(good)!.files.set('draft.json', GOOD_DRAFT);
    await frontierNotesTick(makeIo(w, TUESDAY)); // accepted
    await frontierNotesTick(makeIo(w, TUESDAY)); // auditor starts
    const aud = w.started[2]!;
    w.runs.get(aud)!.state = 'completed';
    w.runs.get(aud)!.files.set('verdict.json', PASS_VERDICT);
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toBe('gate-held');
    expect(w.issues.get('2026-W36')!.status).toBe('held');
    // The operator approves on the recorded session; the next tick releases.
    const actionId = w.states.get('2026-W36')!.gateActionId!;
    w.resolutions.set(actionId, 'approved');
    expect(await frontierNotesTick(makeIo(w, TUESDAY))).toBe('published');
    expect(w.issues.get('2026-W36')!.publishGate?.priorResolution).toBe(true);
  });

  it('THE DAILY IS THE AGENDA: it publishes the top claim, never a chore log', async () => {
    const signals = [
      {
        clusterId: 'code-gen',
        points: [
          { model: 'or-grok-4.6', quality: 1, costPer1K: 6.846255319148936, n: 94 },
          { model: 'or-solar-pro4', quality: 0.979456802063185, costPer1K: 0.023159680851063822, n: 94 },
        ],
      },
    ];
    const w = world();
    const io = (harness: string | null, extra: Partial<DailyIo> = {}): DailyIo => ({
      now: () => TUESDAY,
      agendaSignals: async () => signals,
      publishedClaims: async () => new Map(),
      measurementFooter: async () => '3 measurement cycles ran in the last 24 hours, no recipe reached a frontier.',
      readIssue: (d) => w.issues.get(d) ?? null,
      writeIssueFiles: (i) => void w.issues.set(i.week, i),
      startWorkerRun: async () => {
        const id = `run-piece-${w.started.length + 1}`;
        w.runs.set(id, { state: null, files: new Map() });
        w.started.push(id);
        return id;
      },
      runTerminalState: async (id) => (w.runs.has(id) ? w.runs.get(id)!.state : 'failed'),
      readRunFile: async (id, n) => w.runs.get(id)?.files.get(n) ?? null,
      readState: (d) => w.states.get(d) ?? null,
      writeState: (st, o) => {
        if (o?.exclusive && w.states.has(st.week)) return false;
        w.states.set(st.week, st);
        return true;
      },
      deltaHarness: harness,
      log: (l) => w.log.push(l),
      ...extra,
    });

    // The assignment carries the claim and its evidence — nothing else.
    expect(await dailyPieceTick(io('dd'.repeat(32)))).toMatch(/^daily-delta:/);
    expect(w.log.join(' ')).toMatch(/assigned "The last 2\.1 points of code gen quality cost 296×"/);

    // A piece stating a number outside its evidence is REFUSED.
    const rid = w.started[0]!;
    w.runs.get(rid)!.state = 'completed';
    w.runs.get(rid)!.files.set(
      'piece.json',
      JSON.stringify({ title: 'Code costs 900× more.', plain: 'A 900× premium was measured.', lede: 'l', takeaway: 't' }),
    );
    expect(await dailyPieceTick(io('dd'.repeat(32)))).toBe('daily-published');
    const issue = w.issues.get('2026-09-01')!;
    expect(issue.byline).toBe('Potion Research'); // refused → composed piece
    expect(w.log.join(' ')).toMatch(/states "900".*not in its evidence/);
    expect(issue.title).toMatch(/last 2\.1 points of code gen quality cost 296×/);
    expect(issue.agenda?.id).toBe('quality-premium:code-gen');
    expect(issue.agenda?.claimKey).toContain('grok-4.6');
    // The ledger is a FOOTER now, never the headline.
    expect(issue.auditionNote).toMatch(/3 measurement cycles/);
    expect(issue.title).not.toMatch(/cycles/);
  });

  // THE LATE WRITER (found live 2026-09-04, run-d21f0a1b): the writer's run
  // did 95 seconds of work after 29 MINUTES queued behind another job. The
  // deadline was measuring queue latency, so the finished draft was binned.
  it('a LATE writer keeps its claim on the day and replaces the composed piece', async () => {
    const signals = [
      {
        clusterId: 'code-gen',
        points: [
          { model: 'or-grok-4.6', quality: 1, costPer1K: 6.846255319148936, n: 94 },
          { model: 'or-solar-pro4', quality: 0.979456802063185, costPer1K: 0.023159680851063822, n: 94 },
        ],
      },
    ];
    const w = world();
    let clock = TUESDAY;
    const io = (extra: Partial<DailyIo> = {}): DailyIo => ({
      now: () => clock,
      agendaSignals: async () => signals,
      publishedClaims: async () => new Map(),
      measurementFooter: async () => '3 measurement cycles ran in the last 24 hours, no recipe reached a frontier.',
      readIssue: (d) => w.issues.get(d) ?? null,
      writeIssueFiles: (i) => void w.issues.set(i.week, i),
      startWorkerRun: async () => {
        const id = `run-late-${w.started.length + 1}`;
        w.runs.set(id, { state: null, files: new Map() });
        w.started.push(id);
        return id;
      },
      runTerminalState: async (id) => (w.runs.has(id) ? w.runs.get(id)!.state : 'failed'),
      readRunFile: async (id, n) => w.runs.get(id)?.files.get(n) ?? null,
      readState: (d) => w.states.get(d) ?? null,
      writeState: (st, o) => {
        if (o?.exclusive && w.states.has(st.week)) return false;
        w.states.set(st.week, st);
        return true;
      },
      deltaHarness: 'dd'.repeat(32),
      framingDeadlineMs: 1000,
      log: (l) => w.log.push(l),
      ...extra,
    });

    expect(await dailyPieceTick(io())).toMatch(/^daily-delta:/);
    const rid = w.started[0]!;

    // The run is still queued when the framing deadline passes: the day is
    // filed ON TIME with the composed piece, but stays open for the writer.
    clock = new Date(TUESDAY.getTime() + 60_000);
    expect(await dailyPieceTick(io())).toBe('daily-published');
    expect(w.issues.get('2026-09-01')!.byline).toBe('Potion Research');
    expect(w.states.get('2026-09-01')!.phase).toBe('awaiting-writer');
    expect(w.states.get('2026-09-01')!.assignment?.id).toBe('quality-premium:code-gen');

    // ...and the writer lands. Its prose replaces the composed piece, and a
    // model NAME with a version number in it is not read as a claim.
    w.runs.get(rid)!.state = 'completed';
    w.runs.get(rid)!.files.set(
      'piece.json',
      JSON.stringify({
        title: 'The last 2.1 code gen quality points cost 296 times more.',
        summary: 'grok-4.6 scored 1.000; a withheld model scored 0.979.',
        plain: 'grok-4.6 scored a perfect 1.000 across 94 tasks; the cheaper model scored 0.979.',
        lede: 'The gap is 2.1 points and the price gap is 296 times.',
        takeaway: 'Decide which of the two numbers your workload needs.',
      }),
    );
    clock = new Date(TUESDAY.getTime() + 120_000);
    expect(await dailyPieceTick(io())).toBe('daily-upgraded');
    const upgraded = w.issues.get('2026-09-01')!;
    expect(upgraded.byline).toBe('Delta');
    expect(upgraded.writer?.runId).toBe(rid);
    expect(upgraded.title).toMatch(/296 times more/);
    expect(w.states.get('2026-09-01')!.phase).toBe('done');

    // The day is closed: a later tick does not touch it again.
    expect(await dailyPieceTick(io())).toBeNull();
  });

  // THE VERDICT COMES AFTER (operator, 2026-09-05: "wire the auditor into
  // the daily path"). The weekly HOLDS for its verdict; the daily cannot,
  // so it publishes and then earns — or loses — the byline on the record.
  const GOOD_PIECE = JSON.stringify({
    title: 'The last 2.1 points of code gen quality cost 296 times more.',
    summary: 'grok-4.6 scored 1.000; a withheld model scored 0.979.',
    plain: 'grok-4.6 scored 1.000 across 94 items; the cheaper model scored 0.979.',
    lede: 'The premium buys a thin slice of accuracy on this work.',
    takeaway: 'Use the cheaper model unless the gap is worth it.',
  });

  const dailyWorld = (extra: Partial<DailyIo> = {}) => {
    const w = world();
    let clock = TUESDAY;
    const io = (over: Partial<DailyIo> = {}): DailyIo => ({
      now: () => clock,
      agendaSignals: async () => [
        {
          clusterId: 'code-gen',
          points: [
            { model: 'or-grok-4.6', quality: 1, costPer1K: 6.846255319148936, n: 94 },
            { model: 'or-solar-pro4', quality: 0.979456802063185, costPer1K: 0.023159680851063822, n: 94 },
          ],
        },
      ],
      publishedClaims: async () => new Map(),
      measurementFooter: async () => '3 measurement cycles ran in the last 24 hours.',
      readIssue: (d) => w.issues.get(d) ?? null,
      writeIssueFiles: (i) => void w.issues.set(i.week, i),
      startWorkerRun: async () => {
        const id = `run-v${w.started.length + 1}`;
        w.runs.set(id, { state: null, files: new Map() });
        w.started.push(id);
        return id;
      },
      runTerminalState: async (id) => (w.runs.has(id) ? w.runs.get(id)!.state : 'failed'),
      readRunFile: async (id, n) => w.runs.get(id)?.files.get(n) ?? null,
      readState: (d) => w.states.get(d) ?? null,
      writeState: (st, o) => {
        if (o?.exclusive && w.states.has(st.week)) return false;
        w.states.set(st.week, st);
        return true;
      },
      deltaHarness: 'dd'.repeat(32),
      auditorHarness: 'aa'.repeat(32),
      log: (l) => w.log.push(l),
      ...extra,
      ...over,
    });
    return { w, io, tick: (over: Partial<DailyIo> = {}) => dailyPieceTick(io(over)), at: (ms: number) => void (clock = new Date(TUESDAY.getTime() + ms)) };
  };

  it('publishes first, then sends the piece to Auditor and stamps the verdict', async () => {
    const { w, tick } = dailyWorld();
    expect(await tick()).toMatch(/^daily-delta:/);
    const delta = w.started[0]!;
    w.runs.get(delta)!.state = 'completed';
    w.runs.get(delta)!.files.set('piece.json', GOOD_PIECE);

    // The prose publishes IMMEDIATELY — the day is never held for a verdict.
    expect(await tick()).toBe('daily-published');
    expect(w.issues.get('2026-09-01')!.byline).toBe('Delta');
    expect(w.issues.get('2026-09-01')!.writer?.verifiedBy).toBeUndefined();
    expect(w.states.get('2026-09-01')!.phase).toBe('awaiting-auditor');

    // ...and Auditor is dispatched against the PUBLISHED piece.
    expect(await tick()).toMatch(/^daily-auditor:/);
    const aud = w.started[1]!;
    w.runs.get(aud)!.state = 'completed';
    w.runs.get(aud)!.files.set('verdict.json', PASS_VERDICT);

    expect(await tick()).toBe('daily-verified');
    const verified = w.issues.get('2026-09-01')!;
    expect(verified.byline).toBe('Delta');
    expect(verified.writer?.verifiedBy?.runId).toBe(aud);
    expect(w.states.get('2026-09-01')!.phase).toBe('done');
    expect(await tick()).toBeNull();
  });

  it('RETRACTS the prose when the verdict fails — the composed piece stands', async () => {
    const { w, tick } = dailyWorld();
    await tick();
    const delta = w.started[0]!;
    w.runs.get(delta)!.state = 'completed';
    w.runs.get(delta)!.files.set('piece.json', GOOD_PIECE);
    await tick();
    await tick();
    const aud = w.started[1]!;
    w.runs.get(aud)!.state = 'completed';
    w.runs.get(aud)!.files.set(
      'verdict.json',
      JSON.stringify({ verdict: 'fail', checks: [{ claim: 'the takeaway reverses the finding', method: 'recomputed', ok: false }], requiredChanges: ['the takeaway reverses the finding'] }),
    );

    expect(await tick()).toBe('daily-retracted');
    const stood = w.issues.get('2026-09-01')!;
    expect(stood.byline).toBe('Potion Research');
    expect(stood.writer).toBeNull();
    expect(stood.title).toMatch(/last 2\.1 points of code gen quality cost 296×/);
    expect(w.log.join(' ')).toMatch(/RETRACTED.*reverses the finding/);
  });

  it('treats a verdict that never lands as a fail (fleet R2)', async () => {
    const { w, tick, at } = dailyWorld();
    await tick();
    const delta = w.started[0]!;
    w.runs.get(delta)!.state = 'completed';
    w.runs.get(delta)!.files.set('piece.json', GOOD_PIECE);
    await tick();
    await tick();
    // The auditor run never reaches a terminal state.
    expect(await tick({ auditorCeilingMs: 60_000 })).toBeNull();
    at(120_000);
    expect(await tick({ auditorCeilingMs: 60_000 })).toBe('daily-retracted');
    expect(w.issues.get('2026-09-01')!.byline).toBe('Potion Research');
    expect(w.log.join(' ')).toMatch(/no verdict from/);
  });

  it('does not verify the COMPOSED piece — code needs no verifier', async () => {
    const { w, tick } = dailyWorld();
    await tick();
    const delta = w.started[0]!;
    w.runs.get(delta)!.state = 'failed';
    expect(await tick()).toBe('daily-published');
    expect(w.issues.get('2026-09-01')!.byline).toBe('Potion Research');
    expect(w.states.get('2026-09-01')!.phase).toBe('done');
    expect(w.started).toHaveLength(1);
  });

  it('an empty agenda publishes NOTHING — silence beats filler', async () => {
    const w = world();
    const io: DailyIo = {
      now: () => TUESDAY,
      agendaSignals: async () => [],
      publishedClaims: async () => new Map(),
      measurementFooter: async () => 'x',
      readIssue: () => null,
      writeIssueFiles: (i) => void w.issues.set(i.week, i),
      startWorkerRun: async () => 'run-x',
      runTerminalState: async () => 'completed',
      readRunFile: async () => null,
      readState: (d) => w.states.get(d) ?? null,
      writeState: (st) => {
        w.states.set(st.week, st);
        return true;
      },
      deltaHarness: null,
      log: (l) => w.log.push(l),
    };
    expect(await dailyPieceTick(io)).toBe('agenda-empty');
    expect(w.issues.size).toBe(0);
    expect(w.log.join(' ')).toMatch(/nothing provable left unsaid/);
  });

  it('exhausted attempts fall back to the deterministic draft, which needs no verifier', async () => {
    const w = world();
    w.gate.push('allow');
    const io = makeIo(w, TUESDAY, { maxAttempts: 1 });
    await frontierNotesTick(io); // attempt 1 starts
    const r = w.started[0]!;
    w.runs.get(r)!.state = 'failed';
    expect(await frontierNotesTick(io)).toBe('draft-refused');
    expect(await frontierNotesTick(io)).toBe('deterministic');
    expect(await frontierNotesTick(io)).toBe('published');
    const issue = w.issues.get('2026-W36')!;
    expect(issue.byline).not.toBe('Delta'); // no false credit on a fallback
    expect(issue.writer).toBeNull();
    expect(issue.title).toBe(deterministicDraft(FACTS).title);
  });
});
