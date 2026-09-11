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
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildServer } from '../src/server.js';
import {
  assignmentMargin,
  derivedCostCeilingUsd,
  derivedLatencyBoundMs,
  policyBinding,
  policyOptionsFor,
} from '../src/routes/plan.js';
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
  };
}

/** A point's measured evidence, with the interval real measurement carries. */
function ev(mean: number, half: number): NonNullable<FrontierPoint['evidence']> {
  return {
    cacheKeys: [],
    runIds: ['r'],
    n: 30,
    qualityCi95: half,
    qualityCi: [mean - half, Math.min(1, mean + half)],
  };
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
    expect(speed.point!.strategyHash).toBe('cheap'); // the fastest measured point
    for (const o of options) expect(o.infeasible).toBeNull();
  });

  it('MAKE IT GOOD resolves — a fixed $1 ceiling made it permanently unavailable', () => {
    // The bug an operator hit on a real screen: costPer1K is USD per 1000
    // REQUESTS, so the hardcoded $1.00 ceiling meant a tenth of a cent per
    // request. Agentic tool use measures $6.72–$13.05 per 1000, so EVERY
    // strategy blew it and the card a customer most wants rendered blocked.
    const options = policyOptionsFor([
      pt({ strategyHash: 'cheap', quality: 0.914, costPer1K: 6.7181 }),
      pt({ strategyHash: 'best', quality: 0.957, costPer1K: 13.0541 }),
    ]);
    const quality = options.find((o) => o.priority === 'quality')!;
    expect(quality.point, 'make-it-good must not be blocked by an arbitrary ceiling').not.toBeNull();
    expect(quality.point!.strategyHash).toBe('best');
    // …and the ceiling is DERIVED, never a bigger arbitrary number.
    expect(derivedCostCeilingUsd([pt({ costPer1K: 6.7181 }), pt({ costPer1K: 13.0541 })])).toBe(13.0541);
    expect(derivedCostCeilingUsd([])).toBeNull();
  });

  it('reports the cost of each option RELATIVE to just using the best model', () => {
    const options = policyOptionsFor([
      pt({ strategyHash: 'cheap', quality: 0.914, costPer1K: 6.7181 }),
      pt({ strategyHash: 'best', quality: 0.957, costPer1K: 13.0541 }),
    ]);
    const cost = options.find((o) => o.priority === 'cost')!;
    expect(cost.point!.savedVsBestQuality).toBeCloseTo(1 - 6.7181 / 13.0541, 6);
    // The best-quality option is not "0% cheaper than itself" — that is a
    // comparison with nothing in it, and null says so.
    expect(options.find((o) => o.priority === 'quality')!.point!.savedVsBestQuality).toBeNull();
  });

  it('reports an INFEASIBLE shape with the reason instead of hiding it', () => {
    // Nothing reaches quality 0.80. That option must come back visibly
    // unavailable — the failure mode is dropping it from the list, which reads
    // as "we have three options" when there is one.
    const options = policyOptionsFor([pt({ quality: 0.5, costPer1K: 0.2, latencyP95: 3000 })]);
    const cost = options.find((o) => o.priority === 'cost')!;
    expect(cost.point).toBeNull();
    expect(cost.infeasible).toMatch(/0\.80/);
    // …and the others still resolve, so a partial answer is still useful.
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

describe('the frontier table — every measured strategy, and a row binds a POLICY', () => {
  it('every bindable row binds to ITSELF — verified, not argued', async () => {
    // The real multi-step-reasoning frontier, which falsified the obvious
    // derivation: or-gpt-full (q 0.640, $0.1477) beats or-gemini-flash
    // (q 0.620, $0.1509) on BOTH quality and cost — flash survives only on
    // latency. So min_cost at flash's quality serves FULL, and a naive
    // binding would have shown "Applied ✓" on a row it was not serving.
    const { selectPoint } = await import('@potion/core');
    const { policyForCluster } = await import('@potion/pareto');
    const points = [
      pt({ strategyHash: 'pro', quality: 0.98, costPer1K: 7.494, latencyP95: 12358 }),
      pt({ strategyHash: 'full', quality: 0.64, costPer1K: 0.1477, latencyP95: 3052 }),
      pt({ strategyHash: 'flash', quality: 0.62, costPer1K: 0.1509, latencyP95: 2110 }),
      pt({ strategyHash: 'mini', quality: 0.46, costPer1K: 0.0718, latencyP95: 2986 }),
    ];
    const frontier = {
      id: 'f', clusterId: 'code-gen', version: 1, parentId: null, trigger: 'manual' as const,
      points, pricesVersion: 'v', createdAt: new Date(0).toISOString(),
    };
    for (const p of points) {
      const policy = policyBinding(p, points);
      if (policy === null) continue; // reported as not bindable, never mis-bound
      // the serve path applies the CLUSTER floor before selecting (chat.ts,
      // compile-router.ts) — verify the way it serves
      expect(
        selectPoint(policyForCluster(policy, 'code-gen'), frontier)?.strategyHash,
        `row ${p.strategyHash} bound a policy that serves something else`,
      ).toBe(p.strategyHash);
    }
  });

  // 2026-09-11, found by reading a design partner's September receipts.
  //
  // The 2026-09-06 fix below stopped minting the floor from the mean, but
  // kept writing it to the policy's TOP-LEVEL qualityFloor — so a bar bound
  // from ONE classification row governed every other kind of work the key
  // served. On agentic-tool-use and rewrite-edit nothing cleared it, the
  // resolver fell through to the highest-quality point, and the customer
  // paid $44 and $30 per 1K tokens where a $0.14 point of the same measured
  // quality sat on the frontier — recorded as "$0 saved" because the served
  // point was also the comparator. It also wrote the bound RAW
  // (0.978543771043771) while the proposal-apply path floors to 2dp.
  it('binds a CLUSTER floor: other kinds of work keep the platform default', async () => {
    const { DEFAULT_ORG_POLICY } = await import('@potion/pareto');
    const { floorFor } = await import('../src/routing/floors.js');
    const points = [
      pt({ strategyHash: 'cheap', quality: 0.90, costPer1K: 0.10, latencyP95: 900, evidence: ev(0.90, 0.03) }),
      pt({ strategyHash: 'good', quality: 0.98, costPer1K: 1.00, latencyP95: 800, evidence: ev(0.98, 0.02) }),
    ];
    const bound = policyBinding(points[1]!, points)!;
    expect(bound).not.toBeNull();
    expect(bound.type).toBe('min_cost');
    if (bound.type !== 'min_cost') throw new Error('unreachable');
    expect(Object.keys(bound.clusterFloors ?? {})).toEqual(['code-gen']);
    // the bar lives on THIS cluster…
    expect(floorFor(bound, 'code-gen')).toBeGreaterThan(0.95);
    // …and every other cluster sees what a fresh key would have seen
    const dflt = DEFAULT_ORG_POLICY.type === 'min_cost' ? DEFAULT_ORG_POLICY.qualityFloor : Number.NaN;
    expect(bound.qualityFloor).toBe(dflt);
    expect(floorFor(bound, 'agentic-tool-use')).toBe(dflt);
  });

  it('the floor it mints is a 2dp FLOOR of the bound — one rule with proposal apply', async () => {
    const { qualityLowerBound } = await import('@potion/core');
    const { floorFor, mintFloor } = await import('../src/routing/floors.js');
    const points = [
      pt({ strategyHash: 'cheap', quality: 0.90, costPer1K: 0.10, latencyP95: 900, evidence: ev(0.90, 0.03) }),
      pt({ strategyHash: 'good', quality: 0.98, costPer1K: 1.00, latencyP95: 800, evidence: ev(0.98, 0.0121) }),
    ];
    const target = points[1]!;
    const bound = policyBinding(target, points)!;
    const floor = floorFor(bound, 'code-gen')!;
    expect(floor).toBe(mintFloor(qualityLowerBound(target)));
    expect(floor, 'two decimals, never the raw bound').toBe(Math.floor(floor * 100) / 100);
    expect(floor).toBeLessThanOrEqual(qualityLowerBound(target));
  });

  it('needs a COMPOUND rule for a row that survives only on latency', () => {
    const points = [
      pt({ strategyHash: 'full', quality: 0.64, costPer1K: 0.1477, latencyP95: 3052 }),
      pt({ strategyHash: 'flash', quality: 0.62, costPer1K: 0.1509, latencyP95: 2110 }),
    ];
    const flash = policyBinding(points[1]!, points)!;
    expect(flash.type, 'min_cost cannot isolate a latency-only survivor').toBe('compound');
    // …while a row min_cost CAN isolate keeps the simpler rule.
    expect(policyBinding(points[0]!, points)!.type).toBe('min_cost');
  });

  // 2026-09-06, found by reading production against the Replit evaluation.
  //
  // Every point above is CI-LESS, and that is the only reason this suite was
  // green. selectPoint's min_cost filter tests qualityLowerBound(p) — the
  // CONSERVATIVE bound — while policyBinding minted its floor from the MEAN.
  // For a CI-less point mean == lower bound, so the mint verified and shipped.
  // For any point carrying real evidence the floor sits ABOVE the bound the
  // selector tests, so the target fails its own filter and the row becomes
  // unbindable — and a floor minted that way is unsatisfiable on every other
  // cluster too. In production one such policy (floor 0.978543771043771) put
  // 7 of 10 clusters on fallback=1 for a design partner, and made their
  // min_cost arm the most expensive one in their study.
  it('a row carrying a CONFIDENCE INTERVAL is still bindable', () => {
    const points = [
      pt({ strategyHash: 'cheap', quality: 0.90, costPer1K: 0.10, latencyP95: 900, evidence: ev(0.90, 0.03) }),
      pt({ strategyHash: 'good', quality: 0.98, costPer1K: 1.00, latencyP95: 800, evidence: ev(0.98, 0.02) }),
    ];
    const bound = policyBinding(points[1]!, points);
    expect(bound, 'a measured point with an interval must still bind a policy').not.toBeNull();
  });

  it('the floor it mints is tested the way the SELECTOR tests it', async () => {
    const { selectPoint } = await import('@potion/core');
    const { policyForCluster } = await import('@potion/pareto');
    const points = [
      pt({ strategyHash: 'cheap', quality: 0.90, costPer1K: 0.10, latencyP95: 900, evidence: ev(0.90, 0.03) }),
      pt({ strategyHash: 'good', quality: 0.98, costPer1K: 1.00, latencyP95: 800, evidence: ev(0.98, 0.02) }),
    ];
    const frontier = {
      id: 'f', clusterId: 'code-gen', version: 1, parentId: null, trigger: 'manual' as const,
      points, pricesVersion: 'v', createdAt: new Date(0).toISOString(),
    };
    const bound = policyBinding(points[1]!, points)!;
    expect(bound).not.toBeNull();
    // The floor must be satisfiable by the very point it was derived from —
    // under the cluster floor the serve path applies before selecting.
    expect(selectPoint(policyForCluster(bound, 'code-gen'), frontier)?.strategyHash).toBe('good');
  });

  it('the three priorities may COLLAPSE onto one row — which is why the table exists', () => {
    // Real data from the multi-step-reasoning frontier: cheapest-above-floor
    // and best-quality are the same strategy. Three cards showed it twice and
    // read as a bug; the table shows one row carrying two badges.
    const options = policyOptionsFor([
      pt({ strategyHash: 'pro', quality: 0.98, costPer1K: 7.494, latencyP95: 12358 }),
      pt({ strategyHash: 'flash', quality: 0.62, costPer1K: 0.1509, latencyP95: 2110 }),
    ]);
    const cost = options.find((o) => o.priority === 'cost')!.point!.strategyHash;
    const quality = options.find((o) => o.priority === 'quality')!.point!.strategyHash;
    expect(cost).toBe(quality);
  });
});

describe('the latency bound is DERIVED, because a fixed one had nothing behind it', () => {
  // The bug this pins: with a hardcoded 1000ms bound, ZERO of the 29 measured
  // points in the committed baseline cleared it (p95 runs 3.2s–54s on live
  // evidence), so "make it fast" was permanently unavailable on every single
  // workload — a dial with nothing under it.
  it('is the FASTEST measured p95, so the option exists exactly when evidence does', () => {
    expect(derivedLatencyBoundMs([pt({ latencyP95: 16892 }), pt({ latencyP95: 3156 })])).toBe(3156);
    expect(derivedLatencyBoundMs([])).toBeNull();
  });

  it('rounds UP, so the bound can never exclude the point it was derived from', () => {
    const points = [pt({ strategyHash: 'fastest', latencyP95: 3155.4 })];
    const bound = derivedLatencyBoundMs(points)!;
    expect(bound).toBe(3156);
    expect(bound).toBeGreaterThanOrEqual(points[0]!.latencyP95);
    expect(policyOptionsFor(points).find((o) => o.priority === 'speed')!.point!.strategyHash).toBe(
      'fastest',
    );
  });

  it('offers speed on REAL baseline latencies, where a fixed 1000ms offered nothing', () => {
    // The extraction cluster's actual committed numbers.
    const options = policyOptionsFor([
      pt({ strategyHash: 'slow', quality: 0.98, costPer1K: 0.174, latencyP95: 16892 }),
      pt({ strategyHash: 'fast', quality: 0.91, costPer1K: 0.02, latencyP95: 3156 }),
    ]);
    const speed = options.find((o) => o.priority === 'speed')!;
    expect(speed.point).not.toBeNull();
    expect(speed.point!.strategyHash).toBe('fast');
    expect(speed.policy).toEqual({ type: 'latency_bound', p95Ms: 3156 });
  });

  it('an unmeasured cluster still has NO speed option — derived, not invented', () => {
    const speed = policyOptionsFor([]).find((o) => o.priority === 'speed')!;
    expect(speed.point).toBeNull();
    expect(speed.infeasible).toMatch(/nothing has been measured/);
  });
});

describe('latency provenance — G2.6 harness-vs-serving, carried onto this surface', () => {
  it('defaults to the WEAKER claim when no evidence is supplied', () => {
    const point = policyOptionsFor([pt({})]).find((o) => o.priority === 'cost')!.point!;
    expect(point.latencySource).toBe('harness');
    expect(point.latencyProvisional).toBe(true);
    expect(point.latencySpan).toBe('strategy-only');
  });

  it('reports SERVING-grade evidence as non-provisional when it exists', () => {
    const options = policyOptionsFor([pt({ strategyHash: 'h1' })], {
      h1: { source: 'serving', p95Ms: 820, n: 40, provisional: false, windowMin: 60, span: 'end-to-end' },
    });
    const point = options.find((o) => o.priority === 'cost')!.point!;
    expect(point.latencySource).toBe('serving');
    expect(point.latencyProvisional).toBe(false);
    expect(point.latencySpan).toBe('end-to-end');
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

async function plan(payload: NonNullable<InjectOptions['payload']>) {
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
