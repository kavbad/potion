// Delta writer client (F0) — the run-backed draft path and every fallback:
// the note must ALWAYS publish, and every failure names the run it leaves
// behind so the issue records what happened.
import { describe, expect, it } from 'vitest';
import { auditDraftCounts, auditVagueRatios, deltaDraft } from './delta.js';
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

  it('redacts vague mixing costSaving from the attached fact sheet', async () => {
    const facts: FactSheet = {
      ...FACTS,
      mixing: [
        { family: 'code', kind: 'cheaper-and-as-good', meanQuality: 1, qualityDeltaVsBestSingle: 0, costSaving: 0.911, n: 90, vague: true, costBand: 'more than 8× cheaper' },
        { clusterId: 'summarization', family: 'writing', kind: 'cheaper-and-as-good', meanQuality: 1, qualityDeltaVsBestSingle: 0.014, costSaving: 0.194, n: 14, vague: false, costBand: 'under 1.5× cheaper' },
      ],
    };
    let attached = '';
    const fetchImpl = (async (_: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { attachments: Array<{ contentBase64: string }> };
        attached = Buffer.from(body.attachments[0]!.contentBase64, 'base64').toString('utf8');
      }
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'x' } as Response;
    }) as typeof fetch;
    await deltaDraft(facts, { ...OPTS, fetchImpl });
    expect(attached).not.toContain('0.911');
    expect(attached).toContain('more than 8× cheaper');
    expect(attached).toContain('0.194');
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

  it('the count audit refuses the run-f1164fc6 headline (claims one drifted, facts say two)', () => {
    const facts: FactSheet = {
      ...FACTS,
      frontier: [
        ...Array.from({ length: 8 }, (_, i) => ({ ...FACTS.frontier[0]!, clusterId: `c${i}`, verdict: 'ok' as const })),
        { ...FACTS.frontier[0]!, clusterId: 'classification', verdict: 'drift' as const },
        { ...FACTS.frontier[0]!, clusterId: 'extraction', verdict: 'drift' as const },
      ],
    };
    const bad = { ...GOOD_DRAFT, title: 'One cluster drifted while eight frontier picks held this week.' };
    expect(auditDraftCounts(bad, facts)).toMatch(/claims 1 .*but the fact sheet counts 2/);
    const good = { ...GOOD_DRAFT, title: 'Two clusters drifted while eight frontier picks held this week.' };
    expect(auditDraftCounts(good, facts)).toBeNull();
    const decimals = { ...GOOD_DRAFT, title: 'Two clusters drifted this week.', lede: 'Quality held at 0.886 across the eight clusters that held; two clusters moved to 0.750.' };
    expect(auditDraftCounts(decimals, facts)).toBeNull();
    // run-b5a5d340: "Every frontier held" over an 8-of-10 week.
    const universal = { ...GOOD_DRAFT, title: 'Every frontier held this week; two clusters drifted downward.' };
    expect(auditDraftCounts(universal, facts)).toMatch(/claims 10 held but the fact sheet counts 8/);
    const noneMoved = { ...GOOD_DRAFT, title: 'No frontier moved this week.' };
    expect(auditDraftCounts(noneMoved, facts)).toMatch(/claims 0 .*counts 2/);
    // run-721941f5: a TRUE sentence with an intervening number must not bind
    // "10" to "held" across the "8".
    const trueSentence = { ...GOOD_DRAFT, title: 'This week 8 frontier clusters held and 2 clusters moved.', lede: 'Of 10 canaries across 10 clusters, 8 held and 2 moved.' };
    expect(auditDraftCounts(trueSentence, facts)).toBeNull();
    // run-0eb4bca7: a TRUE partitive — the first number is the claim, and
    // the inner "ten routes held" must not read as a ten-claim.
    const partitive = { ...GOOD_DRAFT, title: 'Eight of ten routes held this week; two structured-output clusters moved to a new pick.', lede: 'Eight of the ten measurement clusters held their stored quality.' };
    expect(auditDraftCounts(partitive, facts)).toBeNull();
    const wrongPartitive = { ...GOOD_DRAFT, title: 'Seven of ten routes held this week.' };
    expect(auditDraftCounts(wrongPartitive, facts)).toMatch(/claims 7 held but the fact sheet counts 8/);
    // run-d4d73505: "withheld" must never match "held", and "drift" (not
    // just "drifted") must break the gap.
    const withheld = { ...GOOD_DRAFT, title: 'Week 2026-W36: 8 of 10 frontier clusters held, 2 drifted.', lede: 'The two drift verdicts are on clusters routed to a name withheld pick.' };
    expect(auditDraftCounts(withheld, facts)).toBeNull();
    // run-d4d73505's internal contradiction: "One new small model was
    // auditioned" while the auditions section correctly said three.
    const audFacts: FactSheet = {
      ...facts,
      auditions: [
        { alias: 'a', clusterId: 'classification', lane: 'small/cheap', outcome: 'did not beat the incumbent' },
        { alias: 'b', clusterId: 'classification', lane: 'small/cheap', outcome: 'did not beat the incumbent' },
        { alias: 'c', clusterId: 'classification', lane: 'small/cheap', outcome: 'did not beat the incumbent' },
      ],
    };
    const oneModel = { ...GOOD_DRAFT, title: 'Two clusters drifted this week.', plain: 'One new small model was auditioned in the classification lane and did not beat the incumbent.' };
    expect(auditDraftCounts(oneModel, audFacts)).toMatch(/claims 1 .*counts 3/);
    const threeModels = { ...GOOD_DRAFT, title: 'Two clusters drifted this week.', plain: 'Three new models were measured and 322 listings were screened; none beat the incumbent.' };
    expect(auditDraftCounts(threeModels, audFacts)).toBeNull();
    // run-aefb6628: the partitive with a demonstrative — "eight of those
    // ten routes held" must consume, never read as "ten routes held".
    const demonstrative = { ...GOOD_DRAFT, title: 'Two clusters drifted this week.', lede: 'This week eight of those ten routes held, meaning their fresh scores landed inside the range.' };
    expect(auditDraftCounts(demonstrative, facts)).toBeNull();
    // run-8f414c4e: the partitive must bind the FIRST noun, never skip
    // across the other clause's count.
    const twoClause = { ...GOOD_DRAFT, title: 'Two clusters drifted this week.', lede: 'We graded 40 items, and held 8 of 10 clusters while 2 clusters drifted and 0 were inconclusive.' };
    expect(auditDraftCounts(twoClause, facts)).toBeNull();
    // run-25d69a3c: verdict-vocabulary mentions count nothing.
    const verdictTalk = { ...GOOD_DRAFT, title: 'Two clusters drifted this week.', frontierNote: 'No cluster was inconclusive this week, so every one of the ten clusters returned a clear held or drift verdict.' };
    expect(auditDraftCounts(verdictTalk, facts)).toBeNull();
  });

  it('the vague-ratio guard refuses a draft leaking an exact saving (run-ff6edfc4)', () => {
    const facts: FactSheet = {
      ...FACTS,
      mixing: [
        { family: 'code', kind: 'cheaper-and-as-good', meanQuality: 1, qualityDeltaVsBestSingle: 0, costSaving: 0.911, n: 90, vague: true, costBand: 'more than 8× cheaper' },
        { clusterId: 'summarization', family: 'writing', kind: 'cheaper-and-as-good', meanQuality: 1, qualityDeltaVsBestSingle: 0.014, costSaving: 0.194, n: 14, vague: false, costBand: 'under 1.5× cheaper' },
      ],
    };
    const leaking = { ...GOOD_DRAFT, mixingNote: 'On code work the saving was 0.911 across 90 items, in the more than 8× cheaper band.' };
    expect(auditVagueRatios(leaking, facts)).toMatch(/vague code mixing entry.*0\.911.*band words only/);
    const pctLeak = { ...GOOD_DRAFT, mixingNote: 'On code work the combination was 91% cheaper.' };
    expect(auditVagueRatios(pctLeak, facts)).toMatch(/91%/);
    const banded = { ...GOOD_DRAFT, mixingNote: 'On code work a combination of measured models was more than 8× cheaper at a mean quality of 1.' };
    expect(auditVagueRatios(banded, facts)).toBeNull();
    // Non-vague entries may state their numbers.
    const nonVague = { ...GOOD_DRAFT, mixingNote: 'On summarization the combination saved 0.194 of the cost, under 1.5× cheaper.' };
    expect(auditVagueRatios(nonVague, facts)).toBeNull();
  });

  it('deltaDraft falls back when the count audit refuses the draft', async () => {
    const facts: FactSheet = {
      ...FACTS,
      frontier: [
        { ...FACTS.frontier[0]!, clusterId: 'a', verdict: 'ok' as const },
        { ...FACTS.frontier[0]!, clusterId: 'b', verdict: 'drift' as const },
      ],
    };
    const contradicting = { ...GOOD_DRAFT, title: 'Three clusters drifted this week.' };
    const r = await deltaDraft(facts, {
      ...OPTS,
      fetchImpl: fakeFetch([
        { status: 202, json: { runId: 'run-d9' } },
        { json: { state: 'completed', cost: { meteredUsd: 0.01 } } },
        { text: JSON.stringify(contradicting) },
      ]),
    });
    expect(r.fallback).toMatch(/count audit: draft claims 3 .*counts 1/);
    expect(r.receipt?.runId).toBe('run-d9');
  });

  it('normalizes sentence-array prose fields and {question, answer} FAQ keys (run-099975b9 shape)', async () => {
    const drift = {
      ...GOOD_DRAFT,
      plain: GOOD_DRAFT.plain.split('. ').map((s, i, a) => (i < a.length - 1 ? `${s}.` : s)),
      lede: [GOOD_DRAFT.lede],
      takeaway: [GOOD_DRAFT.takeaway],
      faq: GOOD_DRAFT.faq.map((f) => ({ question: f.q, answer: f.a })),
    };
    const r = await deltaDraft(FACTS, {
      ...OPTS,
      fetchImpl: fakeFetch([
        { status: 202, json: { runId: 'run-d8' } },
        { json: { state: 'completed', cost: { meteredUsd: 0.01 } } },
        { text: JSON.stringify(drift) },
      ]),
    });
    expect(r.fallback).toBeNull();
    expect(r.draft.lede).toBe(GOOD_DRAFT.lede);
    expect(r.draft.takeaway).toBe(GOOD_DRAFT.takeaway);
    expect(r.draft.plain).toContain('Potion re-checked its scoreboard.');
    expect(r.draft.faq).toEqual(GOOD_DRAFT.faq);
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
