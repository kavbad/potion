// The clock (F4) — window math and the full state machine over a stubbed
// IO: draft → refuse → redraft → verify → gate hold → operator approval →
// publish, plus the deterministic fallback when attempts exhaust.
import { describe, expect, it } from 'vitest';
import { dailyLedgerTick, frontierNotesTick, inTuesdayWindow, isoWeekOf, type ClockIO, type ClockState, type DailyIo } from './clock.js';
import type { FactSheet, Issue } from './types.js';
import { deterministicDraft } from './write.js';

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
    readObservatoryRun: () => (opts.noRun ? null : ({ week: isoWeekOf(now) } as never)),
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

  it('THE DAY IS NEVER MISSED: parked, overdue, or no harness all still publish', async () => {
    const facts = { day: '2026-09-04', at: '', cycles: [], measured: [], promoted: 0, registrySize: 322, pricesVersion: 'p1', spendUsd: 0, quiet: true, caveats: [] };
    const base = (w: World, harness: string | null, extra: Partial<DailyIo> = {}): DailyIo => ({
      now: () => TUESDAY,
      dailyFacts: async () => facts,
      readIssue: (d) => w.issues.get(d) ?? null,
      writeIssueFiles: (i) => void w.issues.set(i.week, i),
      startWorkerRun: async () => {
        const id = `run-daily-${w.started.length + 1}`;
        w.runs.set(id, { state: null, files: new Map() });
        w.started.push(id);
        return id;
      },
      // null means STILL RUNNING — distinct from an unknown run, which is
      // 'failed'. (Conflating them hid the overdue path from this test.)
      runTerminalState: async (id) => (w.runs.has(id) ? w.runs.get(id)!.state : 'failed'),
      readRunFile: async (id, n) => w.runs.get(id)?.files.get(n) ?? null,
      readState: (d) => w.states.get(d) ?? null,
      writeState: (s, o) => {
        if (o?.exclusive && w.states.has(s.week)) return false;
        w.states.set(s.week, s);
        return true;
      },
      deltaHarness: harness,
      log: (l) => w.log.push(l),
      ...extra,
    });

    // 1. A PARKED framing run (the live 2026-09-04 wedge) still publishes.
    const parked = world();
    await dailyLedgerTick(base(parked, 'dd'.repeat(32)));
    parked.runs.get(parked.started[0]!)!.state = 'awaiting-human';
    expect(await dailyLedgerTick(base(parked, 'dd'.repeat(32)))).toBe('daily-published');
    expect(parked.issues.get('2026-09-04')!.status).toBe('published');
    expect(parked.issues.get('2026-09-04')!.byline).toBe('Potion Research');

    // 2. An OVERDUE run (never terminal) is abandoned and the day ships.
    const slow = world();
    await dailyLedgerTick(base(slow, 'dd'.repeat(32)));
    const late = base(slow, 'dd'.repeat(32), { now: () => new Date(TUESDAY.getTime() + 25 * 60_000) });
    expect(await dailyLedgerTick(late)).toBe('daily-published');
    expect(slow.log.join(' ')).toMatch(/framing overdue/);

    // 2b. A completed run whose file is not visible YET waits (the 889ms
    // read-after-write race), then frames when it appears.
    const racy = world();
    await dailyLedgerTick(base(racy, 'dd'.repeat(32)));
    const rid = racy.started[0]!;
    racy.runs.get(rid)!.state = 'completed'; // completed, file not yet readable
    expect(await dailyLedgerTick(base(racy, 'dd'.repeat(32)))).toBeNull();
    expect(racy.issues.size).toBe(0);
    racy.runs.get(rid)!.files.set(
      'daily.json',
      JSON.stringify({ title: 'A quiet day.', summary: 's', plain: 'p', lede: 'l', frontierNote: 'f', auditionNote: 'a', mixingNote: '', takeaway: 't', faq: [] }),
    );
    expect(await dailyLedgerTick(base(racy, 'dd'.repeat(32)))).toBe('daily-published');
    expect(racy.issues.get('2026-09-04')!.byline).toBe('Delta');
    expect(racy.issues.get('2026-09-04')!.writer?.runId).toBe(rid);

    // 3. NO framing generation configured: the ledger publishes unframed.
    const bare = world();
    expect(await dailyLedgerTick(base(bare, null))).toBe('daily-published');
    expect(bare.started).toHaveLength(0);
    expect(bare.issues.get('2026-09-04')!.title).toMatch(/quiet day/i);
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
