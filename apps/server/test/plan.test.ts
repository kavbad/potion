// "WHAT ARE YOU BUILDING?" (SERVING-ROADMAP S2) — the from-scratch path.
//
// The property under test is not "the endpoint returns 200". It is that a
// customer with NO traffic gets a real, measured recommendation AND is told
// exactly how strong it is: which cluster, what else it nearly matched, what
// each policy shape would actually select, and — when nothing is measured or
// nothing is feasible — that plainly, rather than a plausible-looking answer.
//
// Most of these assertions exist to make a comfortable lie fail. The
// tempting shortcuts on a surface like this are all the same shape: hide the
// runner-up, hide the infeasible option, present platform numbers as if they
// were the customer's own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { assignmentMargin, policyOptionsFor } from '../src/routes/plan.js';
import type { FrontierPoint } from '@potion/core';

// ---------------------------------------------------------------- unit ----

function pt(over: Partial<FrontierPoint>): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: 'h'.repeat(8),
    strategyConfig: { type: 'single', model: 'm' },
    quality: 0.9,
    costPer1K: 0.5,
    latencyP95: 800,
    providerMode: 'live',
    ...over,
  } as FrontierPoint;
}

describe('policyOptionsFor — every option carries the point it would really select', () => {
  it('offers all three shapes with their selected point and measured numbers', () => {
    const options = policyOptionsFor([
      pt({ strategyHash: 'cheap', quality: 0.82, costPer1K: 0.1, latencyP95: 400 }),
      pt({ strategyHash: 'best', quality: 0.97, costPer1K: 0.9, latencyP95: 1500 }),
    ]);
    expect(options.map((o) => o.priority)).toEqual(['cost', 'quality', 'speed']);

    const cost = options.find((o) => o.priority === 'cost')!;
    expect(cost.point!.strategyHash).toBe('cheap'); // cheapest above the 0.80 floor
    const quality = options.find((o) => o.priority === 'quality')!;
    expect(quality.point!.strategyHash).toBe('best'); // best under the $1 ceiling
    const speed = options.find((o) => o.priority === 'speed')!;
    expect(speed.point!.strategyHash).toBe('cheap'); // only one under 1000ms
    for (const o of options) expect(o.infeasible).toBeNull();
  });

  it('reports an INFEASIBLE shape with the reason instead of hiding it', () => {
    // Nothing reaches quality 0.80 and nothing is under 1000ms. Both of those
    // options must come back visibly unavailable — the failure mode here is
    // dropping them from the list, which reads as "we have three options" when
    // there is one.
    const options = policyOptionsFor([pt({ quality: 0.5, costPer1K: 0.2, latencyP95: 3000 })]);
    const cost = options.find((o) => o.priority === 'cost')!;
    const speed = options.find((o) => o.priority === 'speed')!;
    expect(cost.point).toBeNull();
    expect(cost.infeasible).toMatch(/0\.80/);
    expect(speed.point).toBeNull();
    expect(speed.infeasible).toMatch(/1000 ms/);
    // …and the one that IS feasible still resolves, so a partial answer is
    // still a useful answer.
    expect(options.find((o) => o.priority === 'quality')!.point).not.toBeNull();
    expect(options).toHaveLength(3); // never silently shortened
  });

  it('an UNMEASURED cluster yields three infeasible options, not three guesses', () => {
    const options = policyOptionsFor([]);
    expect(options).toHaveLength(3);
    expect(options.every((o) => o.point === null && o.infeasible !== null)).toBe(true);
  });

  it('never quietly widens a constraint to manufacture an option', () => {
    // A point just under the quality floor must NOT be offered for 'cost'.
    const options = policyOptionsFor([pt({ quality: 0.799, costPer1K: 0.01, latencyP95: 100 })]);
    expect(options.find((o) => o.priority === 'cost')!.point).toBeNull();
  });
});

describe('assignmentMargin — how close the call was', () => {
  it('is the gap to the runner-up', () => {
    expect(assignmentMargin([{ confidence: 0.9 }, { confidence: 0.4 }])).toBeCloseTo(0.5, 6);
  });
  it('is ~0 for a near tie, which is the whole point of surfacing it', () => {
    expect(assignmentMargin([{ confidence: 0.71 }, { confidence: 0.708 }])).toBeCloseTo(0.002, 6);
  });
  it('handles a single-cluster ranking and an empty one without inventing a gap', () => {
    expect(assignmentMargin([{ confidence: 0.8 }])).toBeCloseTo(0.8, 6);
    expect(assignmentMargin([])).toBe(0);
  });
});

// ------------------------------------------------------------ end to end ----

let app: FastifyInstance;
let cookie: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['POTION_SELF_SERVE', 'POTION_MAGIC_LINK_IN_RESPONSE', 'POTION_DEV_AUTH']) {
    saved[k] = process.env[k];
  }
  process.env.POTION_SELF_SERVE = '1';
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_DEV_AUTH = '0';
  // A BARE database with the platform baseline: the from-scratch case, on the
  // shape a real deployment boots with.
  app = await buildServer({ seed: false, platformBaseline: true });

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'idea@startup.test' },
  });
  const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({ method: 'GET', url: `/auth/verify?token=${encodeURIComponent(token)}` });
  cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function plan(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/plan',
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });
}

describe('POST /api/plan — an org with zero traffic, describing an idea', () => {
  it('classifies the idea and answers with MEASURED options on a bare database', async () => {
    const res = await plan({ description: 'Write and fix Python functions from natural language' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.intent.cluster.clusterId).toBe('code-gen');
    expect(body.intent.cluster.name).toBeTruthy();
    // The evidence is the platform frontier, live-provenance, from the baseline.
    expect(body.evidence.measured).toBe(true);
    expect(body.evidence.provenance).toBe('live');
    expect(body.evidence.pointCount).toBeGreaterThan(0);
    // At least one option resolves to a real strategy with a real number.
    const feasible = body.options.filter((o: { point: unknown }) => o.point !== null);
    expect(feasible.length).toBeGreaterThan(0);
    expect(feasible[0].point.quality).toBeGreaterThan(0);
    expect(feasible[0].point.providerMode).toBe('live');
  }, 60_000);

  it('NAMES the basis — these are platform numbers, not the caller own traffic', async () => {
    // The claim being made is genuinely weaker than an org-frontier claim, and
    // a field is harder to drop in a redesign than a sentence of page prose.
    const body = (await plan({ description: 'Summarize long meeting transcripts' })).json();
    expect(body.basis).toBe('platform-measured');
  }, 60_000);

  it('shows the ALTERNATIVES and the margin, so a bad guess is correctable', async () => {
    const body = (await plan({ description: 'Summarize long meeting transcripts into bullets' })).json();
    expect(body.intent.alternatives.length).toBeGreaterThan(0);
    // The chosen cluster is never repeated in its own alternatives list.
    const ids = body.intent.alternatives.map((a: { clusterId: string }) => a.clusterId);
    expect(ids).not.toContain(body.intent.cluster.clusterId);
    // Alternatives are ordered, and the margin is a real number we can act on.
    expect(typeof body.intent.margin).toBe('number');
    for (let i = 1; i < body.intent.alternatives.length; i++) {
      expect(body.intent.alternatives[i - 1].confidence).toBeGreaterThanOrEqual(
        body.intent.alternatives[i].confidence,
      );
    }
  }, 60_000);

  it('SAMPLES outrank the description — real traffic beats a description of it', async () => {
    // Someone describes a "support assistant" but every actual prompt is
    // extraction. The prompts are the workload; the sentence is a guess about
    // it, and routing the guess would mis-serve every request.
    const body = (
      await plan({
        description: 'A helpful assistant for my support team',
        samples: [
          'Extract the invoice number, date and total from this text as JSON',
          'Parse this email and extract every name field into JSON',
          'Extract all entities mentioned in this contract as JSON',
        ],
      })
    ).json();
    expect(body.intent.cluster.clusterId).toBe('extraction');
    expect(body.intent.sampleCount).toBe(3);
    // And we show HOW the samples classified, so the override is inspectable
    // rather than a silent correction.
    expect(body.intent.sampleBreakdown.extraction).toBe(3);
  }, 60_000);

  it('is deterministic — the same idea twice gives the same plan', async () => {
    const a = (await plan({ description: 'Classify incoming tickets by topic' })).json();
    const b = (await plan({ description: 'Classify incoming tickets by topic' })).json();
    expect(a).toEqual(b);
  }, 60_000);

  it('creates NOTHING — no policy, no key, no traffic', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/connection', headers: { cookie } })).json();
    await plan({ description: 'Rewrite marketing copy in a friendlier tone' });
    const after = (await app.inject({ method: 'GET', url: '/api/connection', headers: { cookie } })).json();
    expect(after.servingKeys).toEqual(before.servingKeys);
    expect(after.policy).toEqual(before.policy);
  }, 60_000);

  it('rejects an empty or oversized description rather than embedding it', async () => {
    expect((await plan({ description: '' })).statusCode).toBe(400);
    expect((await plan({})).statusCode).toBe(400);
    expect((await plan({ description: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await plan({ description: 'ok', samples: Array(11).fill('a') })).statusCode).toBe(400);
  });
});

describe('the from-scratch flow, end to end', () => {
  it('idea -> plan -> apply the chosen option -> a ROUTED first request', async () => {
    // This is S2's whole done-when, in one test: somebody with nothing leaves
    // with a policy, a key, and a request that was actually routed.
    const planned = (
      await plan({ description: 'Generate and repair Python code from plain english instructions' })
    ).json();
    const chosen = planned.options.find((o: { point: unknown }) => o.point !== null);
    expect(chosen, 'no feasible option to apply').toBeTruthy();

    const created = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { policy: chosen.policy, createKey: true },
    });
    expect(created.statusCode).toBe(201);
    const apiKey = created.json().apiKey as string;

    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: {
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Write a Python function that merges two sorted lists.' }],
      },
    });
    expect(chat.statusCode).toBe(200);
    const trace = String(chat.headers['x-frontier-trace']);
    expect(trace).toContain('fallback=0');
    expect(trace).toContain('provenance=live');
    // The request landed in the cluster the plan said it would — the promise
    // the page made is the promise the endpoint kept.
    expect(trace).toContain(`cluster=${planned.intent.cluster.clusterId}`);
  }, 60_000);
});
