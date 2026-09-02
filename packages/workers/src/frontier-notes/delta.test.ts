// Delta writer client (F0) — the run-backed draft path and every fallback:
// the note must ALWAYS publish, and every failure names the run it leaves
// behind so the issue records what happened.
import { describe, expect, it } from 'vitest';
import { deltaDraft } from './delta.js';
import { deterministicDraft } from './write.js';
import type { FactSheet } from './types.js';

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

const GOOD_DRAFT = {
  title: 'Every frontier held this week.',
  summary: 'One canary re-check; the routed pick reproduced its stored quality.',
  plain: 'Potion re-checked its scoreboard. Nothing got worse. No new model was measured. Nothing changed.',
  lede: 'One canary re-checked the code frontier. The pick scored 0.983 against 0.981, give or take 0.020, stored. Nothing moved.',
  frontierNote: 'The routed pick reproduced its stored quality inside its interval.',
  auditionNote: 'No new model looked suited to a cluster this week.',
  mixingNote: 'Nothing in the mixing lane was both cheaper and as good.',
  takeaway: 'Routing to the cheapest model that passes the exam is how you keep quality and stop overpaying.',
  faq: [
    { q: 'What is a routing frontier?', a: 'The short list of best-value models for one kind of work.' },
    { q: 'Did quality change?', a: 'No; the canary reproduced the stored score.' },
    { q: 'Which model held?', a: 'The pick is withheld by name; its numbers are published.' },
  ],
};

interface Call {
  url: string;
  method: string;
}

/** A scripted fetch: each entry answers the next request. */
function fakeFetch(script: Array<{ status?: number; json?: unknown; text?: string }>, calls: Call[] = []): typeof fetch {
  let i = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    const status = step?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => step?.json ?? {},
      text: async () => step?.text ?? JSON.stringify(step?.json ?? {}),
    } as Response;
  }) as typeof fetch;
}

const OPTS = { url: 'https://api.test', session: 's', harnessHash: 'a'.repeat(64), pollMs: 0, timeoutMs: 60_000 };

describe('deltaDraft', () => {
  it('drafts from the completed run\'s draft.json and returns the run receipt', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(
      [
        { status: 202, json: { runId: 'run-d1' } },
        { json: { state: 'running', cost: { meteredUsd: 0 } } },
        { json: { state: 'completed', cost: { meteredUsd: 0.0123 }, judge: { score: 9 } } },
        { text: JSON.stringify(GOOD_DRAFT) },
      ],
      calls,
    );
    const r = await deltaDraft(FACTS, { ...OPTS, fetchImpl });
    expect(r.fallback).toBeNull();
    expect(r.draft.title).toBe(GOOD_DRAFT.title);
    expect(r.receipt).toEqual({ runId: 'run-d1', harnessHash: OPTS.harnessHash, state: 'completed', meteredUsd: 0.0123, judgeScore: 9 });
    expect(calls[0]).toEqual({ url: 'https://api.test/api/lab/runs', method: 'POST' });
    expect(calls.at(-1)?.url).toBe('https://api.test/api/lab/runs/run-d1/files/draft.json');
  });

  it('attaches the fact sheet to the run it creates', async () => {
    let body: { attachments?: Array<{ name: string; contentBase64: string }> } = {};
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') body = JSON.parse(String(init.body));
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'x' } as Response;
    }) as typeof fetch;
    await deltaDraft(FACTS, { ...OPTS, fetchImpl });
    expect(body.attachments?.[0]?.name).toBe('facts.json');
    const decoded = JSON.parse(Buffer.from(body.attachments![0]!.contentBase64, 'base64').toString('utf8')) as FactSheet;
    expect(decoded.week).toBe('2026-W36');
  });

  it('falls back on a refused run creation, with no receipt', async () => {
    const r = await deltaDraft(FACTS, { ...OPTS, fetchImpl: fakeFetch([{ status: 403, text: 'forbidden' }]) });
    expect(r.fallback).toMatch(/delta HTTP 403/);
    expect(r.receipt).toBeNull();
    expect(r.draft).toEqual(deterministicDraft(FACTS));
  });

  it('falls back when the run parks, leaving it parked and naming the question', async () => {
    const r = await deltaDraft(FACTS, {
      ...OPTS,
      fetchImpl: fakeFetch([
        { status: 202, json: { runId: 'run-d2' } },
        { json: { state: 'awaiting-human', pendingQuestion: 'Which week is this?', cost: { meteredUsd: 0.001 } } },
      ]),
    });
    expect(r.fallback).toMatch(/run-d2 parked with a question \("Which week is this\?"\)/);
    expect(r.receipt?.state).toBe('awaiting-human');
    expect(r.draft).toEqual(deterministicDraft(FACTS));
  });

  it('falls back on a failed run with the state reason', async () => {
    const r = await deltaDraft(FACTS, {
      ...OPTS,
      fetchImpl: fakeFetch([
        { status: 202, json: { runId: 'run-d3' } },
        { json: { state: 'failed', stateReason: 'sandbox exploded' } },
      ]),
    });
    expect(r.fallback).toMatch(/run-d3 ended failed: sandbox exploded/);
    expect(r.receipt?.state).toBe('failed');
  });

  it('falls back on timeout and leaves the run to finish on its own', async () => {
    const r = await deltaDraft(FACTS, {
      ...OPTS,
      timeoutMs: 0,
      fetchImpl: fakeFetch([{ status: 202, json: { runId: 'run-d4' } }, { json: { state: 'running' } }]),
    });
    expect(r.fallback).toMatch(/run-d4 still running after 0s/);
    expect(r.receipt?.runId).toBe('run-d4');
  });

  it('falls back when the completed run has no draft.json (the file-claims seam)', async () => {
    const r = await deltaDraft(FACTS, {
      ...OPTS,
      fetchImpl: fakeFetch([
        { status: 202, json: { runId: 'run-d5' } },
        { json: { state: 'completed', cost: { meteredUsd: 0.01 } } },
        { status: 404, text: 'nope' },
      ]),
    });
    expect(r.fallback).toMatch(/draft\.json is not in the run files \(HTTP 404\)/);
    expect(r.receipt?.state).toBe('completed');
  });

  it('falls back when draft.json does not parse as a draft', async () => {
    const r = await deltaDraft(FACTS, {
      ...OPTS,
      fetchImpl: fakeFetch([
        { status: 202, json: { runId: 'run-d6' } },
        { json: { state: 'completed', cost: { meteredUsd: 0.01 } } },
        { text: '{"not":"a draft"}' },
      ]),
    });
    expect(r.fallback).toMatch(/did not parse as a draft/);
    expect(r.draft).toEqual(deterministicDraft(FACTS));
  });
});
