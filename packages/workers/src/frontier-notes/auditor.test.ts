// Auditor verifier client (F1) — the pass path and every no-verdict path.
// The caller's law: no verdict is a FAIL for the model-written draft, so
// every fallback here must be typed and name the run when one exists.
import { describe, expect, it } from 'vitest';
import { auditorVerify, parseVerdict } from './auditor.js';
import type { FactSheet } from './types.js';
import type { Draft } from './write.js';

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

const DRAFT: Draft = {
  title: 'Every frontier held this week.',
  summary: 's',
  plain: 'p',
  lede: 'l',
  frontierNote: 'f',
  auditionNote: 'a',
  mixingNote: 'm',
  takeaway: 't',
  faq: [
    { q: 'q1', a: 'a1' },
    { q: 'q2', a: 'a2' },
    { q: 'q3', a: 'a3' },
  ],
};

const PASS_VERDICT = {
  verdict: 'pass',
  checks: [
    { claim: '1 cluster held', method: 'recomputed', ok: true, note: 'numbers.clustersHeld = 1' },
    { claim: 'spend $0.40', method: 'recomputed', ok: true },
  ],
  requiredChanges: [],
};

function fakeFetch(script: Array<{ status?: number; json?: unknown; text?: string }>): typeof fetch {
  let i = 0;
  return (async () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    const status = step?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => step?.json ?? {},
      text: async () => step?.text ?? JSON.stringify(step?.json ?? {}),
    } as Response;
  }) as typeof fetch;
}

const OPTS = { url: 'https://api.test', session: 's', harnessHash: 'b'.repeat(64), pollMs: 0, timeoutMs: 60_000 };

describe('parseVerdict', () => {
  it('parses a pass record', () => {
    const v = parseVerdict(JSON.stringify(PASS_VERDICT));
    expect(v?.verdict).toBe('pass');
    expect(v?.checks).toHaveLength(2);
  });

  it('a pass with a failed check is a fail — the record outranks the word', () => {
    const withFailedCheck = { ...PASS_VERDICT, checks: [...PASS_VERDICT.checks, { claim: 'x', method: 'recomputed', ok: false }] };
    expect(parseVerdict(JSON.stringify(withFailedCheck))?.verdict).toBe('fail');
  });

  it('a pass whose only defect is required changes is the MIDDLE state, not a fail', () => {
    const withChanges = { ...PASS_VERDICT, requiredChanges: ['fix the title count'] };
    const v = parseVerdict(JSON.stringify(withChanges));
    expect(v?.verdict).toBe('pass-with-changes');
    expect(v?.requiredChanges).toEqual(['fix the title count']);
  });

  it('tolerates case and drops malformed check rows, but never invents a verdict', () => {
    const sloppy = { verdict: 'PASS', checks: [{ claim: 'ok one', method: 'recomputed', ok: true }, { bogus: true }], requiredChanges: [] };
    const v = parseVerdict(JSON.stringify(sloppy));
    expect(v?.verdict).toBe('pass');
    expect(v?.checks).toHaveLength(1);
    expect(parseVerdict('{"no":"verdict"}')).toBeNull();
    expect(parseVerdict('not json')).toBeNull();
  });
});

describe('auditorVerify', () => {
  it('returns the typed verdict from a completed run', async () => {
    const r = await auditorVerify(FACTS, DRAFT, {
      ...OPTS,
      fetchImpl: fakeFetch([
        { status: 202, json: { runId: 'run-a1' } },
        { json: { state: 'completed', cost: { meteredUsd: 0.004 }, judge: { score: 9 } } },
        { text: JSON.stringify(PASS_VERDICT) },
      ]),
    });
    expect(r.fallback).toBeNull();
    expect(r.verdict).toMatchObject({ verdict: 'pass', runId: 'run-a1', meteredUsd: 0.004, judgeScore: 9 });
  });

  it('attaches BOTH facts.json and draft.json', async () => {
    let names: string[] = [];
    const fetchImpl = (async (_: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { attachments: Array<{ name: string }> };
        names = body.attachments.map((a) => a.name);
      }
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'x' } as Response;
    }) as typeof fetch;
    await auditorVerify(FACTS, DRAFT, { ...OPTS, fetchImpl });
    expect(names).toEqual(['facts.json', 'draft.json']);
  });

  it('returns null verdict with a typed note on park, failure, timeout, missing or unparseable record', async () => {
    const parked = await auditorVerify(FACTS, DRAFT, {
      ...OPTS,
      fetchImpl: fakeFetch([{ status: 202, json: { runId: 'run-a2' } }, { json: { state: 'awaiting-human', pendingQuestion: 'why?' } }]),
    });
    expect(parked.verdict).toBeNull();
    expect(parked.fallback).toMatch(/run-a2 parked/);

    const failed = await auditorVerify(FACTS, DRAFT, {
      ...OPTS,
      fetchImpl: fakeFetch([{ status: 202, json: { runId: 'run-a3' } }, { json: { state: 'failed', stateReason: 'boom' } }]),
    });
    expect(failed.fallback).toMatch(/run-a3 ended failed: boom/);

    const timedOut = await auditorVerify(FACTS, DRAFT, {
      ...OPTS,
      timeoutMs: 0,
      fetchImpl: fakeFetch([{ status: 202, json: { runId: 'run-a4' } }, { json: { state: 'running' } }]),
    });
    expect(timedOut.fallback).toMatch(/run-a4 still running/);

    const noFile = await auditorVerify(FACTS, DRAFT, {
      ...OPTS,
      fetchImpl: fakeFetch([{ status: 202, json: { runId: 'run-a5' } }, { json: { state: 'completed' } }, { status: 404, text: 'nope' }]),
    });
    expect(noFile.fallback).toMatch(/verdict\.json is not in the run files/);

    const garbled = await auditorVerify(FACTS, DRAFT, {
      ...OPTS,
      fetchImpl: fakeFetch([{ status: 202, json: { runId: 'run-a6' } }, { json: { state: 'completed' } }, { text: '{"weird": 1}' }]),
    });
    expect(garbled.fallback).toMatch(/did not parse as a verification record/);
  });
});
