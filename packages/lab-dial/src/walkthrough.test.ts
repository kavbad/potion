// The Step 7 definition of done, walkthrough-style against the REAL
// serving route:
//   Leg 1 — felt sweep with the DURABLE cache: request_logs count invariant
//           (second sweep adds ZERO rows).
//   Leg 2 — three-surface strategy-hash agreement: the dial VIEW, the FELT
//           trace, and the RUN's step traces all name the same point under
//           the same materialized policy.
//   Leg 3 — the R/M/K flip measured through the route: a tolerance move
//           changes which strategy actually serves.
//   Leg 4 — partition under motion: a tool-bearing harness's full sweep
//           never touches the composite; serving's 400 is never triggered.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash } from '@potion/core';
import type { Frontier, FrontierPoint } from '@potion/core';
import {
  clusters,
  createDb,
  createOrg,
  getFeltSample,
  insertApiKey,
  insertFeltSample,
  insertPolicy,
  insertRequestLog,
  migrate,
  requestLogs,
  type DbHandle,
} from '@potion/db';
import { loadCurrentFrontier, saveFrontier } from '@potion/pareto';
import { harnessSpecHash, parseHarnessSpecText } from '@potion/lab-spec';
import { ServingClient, startRun } from '@potion/lab-runtime';
import type { StepPayload } from '@potion/lab-runtime';
import { buildServer } from '@potion/server/server';
import { eq } from 'drizzle-orm';
import { buildDialDomain, dialViews, viewPosition } from './geometry.js';
import { dialPolicyName, materializeDialPolicy } from './materialize.js';
import { feltSweep, missionProbe, requestLogCostLookup, type FeltCache, type FeltPositionRequest } from './felt.js';
import { loadDialContext } from './context.js';
import { domainFromContext } from './geometry.js';

const ORG = 'org_lab_dial_wt';
const RAW_KEY = 'pk_lab_dial_walkthrough_1';

let h: DbHandle;
let app: FastifyInstance;
let baseUrl: string;

// Fixture points are SELF-CONSISTENT: strategyHash = core's
// strategyHash(config), because serving's trace recomputes the hash from
// the config it executes — a fabricated row hash can never match the
// trace (learned in this walkthrough's first run).
function livePoint(model: string, over: Partial<FrontierPoint> = {}): FrontierPoint {
  const config = { type: 'single' as const, model };
  return {
    clusterId: 'summarization',
    strategyHash: strategyHash(config),
    strategyConfig: config,
    quality: 0.85,
    costPer1K: 0.012,
    latencyP95: 700,
    providerMode: 'live',
    evidence: { cacheKeys: ['ck-wt'], runIds: ['run-wt'], n: 14, qualityCi95: 0.02, suiteContentHash: 'd'.repeat(64) },
    ...over,
  };
}

const P_CHEAP = livePoint('gpt-mini-class', { quality: 0.5, costPer1K: 0.004, latencyP95: 300 });
const P_R = livePoint('haiku-class', { quality: 0.9, costPer1K: 1.0, latencyP95: 1300 });
const P_M = livePoint('gemini-flash-class', { quality: 0.3, costPer1K: 1.05, latencyP95: 40 });
const P_K = livePoint('sonnet-class', { quality: 0.9, costPer1K: 1.15, latencyP95: 900 });

function dbCache(): FeltCache {
  return {
    get: async (key) => {
      const row = await getFeltSample(h.db, key);
      if (row === null) return null;
      return {
        orgId: row.orgId, probeHash: row.probeHash, policyHash: row.policyHash,
        frontierId: row.frontierId,
        strategyHash8: row.strategyHash, // the column stores the trace's 8-char prefix
        frontierVersion: row.frontierVersion, provenance: row.provenance,
        // Only CLEAN samples are ever cached (poison prevention), so the
        // markers are false by construction on read.
        fallback: false, latencyViolated: false,
        output: row.output, costUsd: row.costUsd, latencyMs: row.latencyMs,
        completionId: row.completionId, cached: true,
      };
    },
    put: async (row) => {
      await insertFeltSample(h.db, {
        orgId: row.orgId, probeHash: row.probeHash, policyHash: row.policyHash,
        frontierId: row.frontierId, strategyHash: row.strategyHash8,
        frontierVersion: row.frontierVersion, provenance: row.provenance,
        output: row.output, costUsd: row.costUsd, latencyMs: row.latencyMs,
        completionId: row.completionId,
      });
    },
  };
}

function feltDeps(cluster = 'summarization') {
  return { clientFor: clientForCluster(cluster), cache: dbCache(), costLookup: requestLogCostLookup(h.db) };
}

function clientForCluster(cluster: string) {
  return (policyRef: string): ServingClient =>
    new ServingClient({ baseUrl, apiKey: RAW_KEY, policyRef, clusterHint: cluster });
}

async function logCount(): Promise<number> {
  return (await h.db.select().from(requestLogs).where(eq(requestLogs.orgId, ORG))).length;
}

const MISSION = { goal: 'Summarize the weekly meeting notes into a digest', doneDefinition: 'A digest exists' };

beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Dial Walkthrough Org' });
  await insertPolicy(h.db, {
    id: 'pol-dial-wt-key', orgId: ORG, name: 'dial-wt-key',
    config: { type: 'min_cost', qualityFloor: 0 },
  });
  await insertApiKey(h.db, {
    id: 'key-dial-wt', keyHash: sha256(RAW_KEY), name: 'dial walkthrough',
    orgId: ORG, policyId: 'pol-dial-wt-key', rateRps: 1000, dailyCap: 100_000,
  });
  // The taxonomy cluster row (platform) — X-Potion-Cluster resolves it.
  await h.db.insert(clusters).values({
    id: 'summarization', name: 'summarization', description: 'Taxonomy cluster (walkthrough)',
  }).onConflictDoNothing();
  // A live-labeled platform frontier containing the R/M/K triple PLUS a
  // cheap default single — the dial's world for all four legs.
  await saveFrontier(h.db, 'summarization', [P_CHEAP, P_R, P_M, P_K], 'recompute', 'pv-dial-wt');
  app = await buildServer({ db: h, seed: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

async function domainNow() {
  const ctx = await loadDialContext(h.db, { orgId: ORG, clusterId: 'summarization' });
  if (!ctx.ok) throw new Error(`context gap ${ctx.gap.code}`);
  const r = domainFromContext(ctx.context, { slot: 'brain', toolBearing: false });
  if (!r.ok) throw new Error(`gap ${r.gap.code}`);
  return r.domain;
}

describe('Leg 1 — felt sweep with the durable cache (request_logs invariant)', () => {
  it('first sweep meters real calls; the repeat adds ZERO rows', async () => {
    const domain = await domainNow();
    const probe = missionProbe(MISSION);
    const positions: FeltPositionRequest[] = [];
    for (const k of [0, domain.ladder.length - 1]) {
      const view = viewPosition(domain, { qualityIndex: k });
      if (!view.feasible) throw new Error('infeasible');
      const row = await materializeDialPolicy(h.db, {
        orgId: ORG, harnessHash: `felthash${k}`.padEnd(12, '0'), slot: 'brain', policy: view.policy,
      });
      positions.push({ orgId: ORG, probe, policy: view.policy, policyRef: row.name, frontierId: domain.frontierId });
    }
    const deps = feltDeps();
    const before = await logCount();
    const first = await feltSweep(positions, deps);
    expect(first.samples.every((s) => s.outcome.ok)).toBe(true);
    const afterFirst = await logCount();
    expect(afterFirst - before).toBe(positions.length);
    const second = await feltSweep(positions, deps);
    expect(second.samples.every((s) => s.outcome.ok && s.outcome.sample.cached)).toBe(true);
    expect(await logCount()).toBe(afterFirst); // THE invariant: zero new rows
    // The trace's provenance echoes the POINT's evidence lineage (G1.7):
    // these fixture points are live-labeled, so the felt sample carries
    // 'live'. (A real mock deployment has mock-evidence frontiers →
    // provenance=mock → labeled simulated; that pairing is pinned in
    // felt.test.ts. This fixture deliberately fabricates live-labeled
    // points on a mock server, which reality does not do.)
    for (const s of first.samples) {
      if (s.outcome.ok) expect(s.outcome.sample.provenance).toBe('live');
    }
  }, 120_000);
});

describe('Leg 2 — three-surface strategy-hash agreement', () => {
  it('view === felt trace === run step traces, under the same materialized policy', async () => {
    const domain = await domainNow();
    // The cheap rung: only a1cheap00 qualifies at min cost.
    const view = viewPosition(domain, { qualityIndex: 0 });
    if (!view.feasible) throw new Error('infeasible');

    const spec = {
      specVersion: 1 as const, name: 'dial-agreement-harness',
      brain: { policy: view.policy },
      mission: { kind: 'task' as const, goal: MISSION.goal, doneDefinition: MISSION.doneDefinition },
      superpowers: [], memory: { enabled: false }, rules: [],
      fuel: { maxUsdPerRun: 1, hardStop: true as const }, checkIns: [],
    };
    const specText = JSON.stringify({ ...spec, hash: harnessSpecHash(spec) });
    expect(parseHarnessSpecText(specText).ok).toBe(true);
    const row = await materializeDialPolicy(h.db, {
      orgId: ORG, harnessHash: harnessSpecHash(spec), slot: 'brain', policy: view.policy,
    });

    // Surface 2: the felt trace.
    const probe = missionProbe(MISSION);
    const felt = await feltSweep(
      [{ orgId: ORG, probe, policy: view.policy, policyRef: row.name, frontierId: domain.frontierId }],
      feltDeps(),
    );
    const feltSample = felt.samples[0]!.outcome;
    if (!feltSample.ok) throw new Error('felt failed');
    expect(feltSample.sample.strategyHash8).toBe(view.strategyHash.slice(0, 8));

    // Surface 3: the RUN — every step served under the same policy row.
    const runClient = new ServingClient({ baseUrl, apiKey: RAW_KEY, policyRef: row.name, clusterHint: 'summarization' });
    const { runId, outcome } = await startRun({ db: h.db, client: runClient, orgId: ORG, specText });
    expect(outcome.status).toBe('completed');
    const { listLabSteps } = await import('@potion/db');
    const steps = await listLabSteps(h.db, runId, ORG);
    const modelSteps = steps.filter((s) => s.kind === 'model');
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);
    for (const s of modelSteps) {
      const trace = (s.payload as StepPayload).frontierTrace ?? '';
      expect(trace).toContain(`strategy=${view.strategyHash.slice(0, 8)}`);
      expect(trace).toContain(`policy_override=${row.name}`);
    }
  }, 120_000);
});

describe('Leg 3 — the R/M/K flip, measured through the route', () => {
  it('a tolerance move changes which strategy actually serves the same rung', async () => {
    const domain = await domainNow();
    const topRung = domain.ladder.length - 1; // quality 0.9: R vs K
    const relaxed = viewPosition(domain, { qualityIndex: topRung });
    const tightened = viewPosition(domain, { qualityIndex: topRung, toleranceMs: 1000 });
    if (!relaxed.feasible || !tightened.feasible) throw new Error('infeasible');
    expect(relaxed.strategyHash).toBe(P_R.strategyHash); // cheap-slow R
    expect(tightened.strategyHash).toBe(P_K.strategyHash); // fast-pricier K

    const probe = missionProbe({ goal: 'Flip probe', doneDefinition: 'Flip check' });
    const traces: string[] = [];
    for (const [label, view] of [['relaxed', relaxed], ['tight', tightened]] as const) {
      const row = await materializeDialPolicy(h.db, {
        orgId: ORG, harnessHash: `flip${label}`.padEnd(12, '0'), slot: 'brain', policy: view.policy,
      });
      const felt = await feltSweep(
        [{ orgId: ORG, probe, policy: view.policy, policyRef: row.name, frontierId: domain.frontierId }],
        feltDeps(),
      );
      const o = felt.samples[0]!.outcome;
      if (!o.ok) throw new Error(`felt ${label} failed`);
      traces.push(o.sample.strategyHash8);
    }
    expect(traces[0]).toBe(P_R.strategyHash.slice(0, 8)); // R through the route
    expect(traces[1]).toBe(P_K.strategyHash.slice(0, 8)); // K — the flip, measured
    expect(traces[0]).not.toBe(traces[1]);

    // The infeasible edge: tolerance 30 → typed gap, evidence-sourced hint.
    const infeasible = viewPosition(domain, { qualityIndex: topRung, toleranceMs: 30 });
    expect(infeasible.feasible).toBe(false);
    if (!infeasible.feasible) expect(infeasible.gap.relaxHintMs).toBe(900);
  }, 120_000);
});

describe('Leg 4 — partition under motion against the real route', () => {
  it('a tool-bearing sweep never touches the composite; no serving 400 fires', async () => {
    // Add a composite to the frontier world (new version), then sweep the
    // TOOLS slot: the composite must be invisible at every position.
    const current = (await loadCurrentFrontier(h.db, 'summarization')) as Frontier;
    const cascadeConfig = {
      type: 'cascade' as const,
      stages: [{ model: 'gpt-mini-class' }, { model: 'frontier-class' }],
      confidenceMethod: 'self-report-calibrated' as const,
    };
    const cascade: FrontierPoint = {
      ...livePoint('gpt-mini-class', { quality: 0.95, costPer1K: 0.006, latencyP95: 1000 }),
      strategyConfig: cascadeConfig,
      strategyHash: strategyHash(cascadeConfig),
    };
    await saveFrontier(h.db, 'summarization', [...current.points, cascade], 'recompute', 'pv-dial-wt2');
    const frontier = (await loadCurrentFrontier(h.db, 'summarization')) as Frontier;
    const r = buildDialDomain({ frontier, clusterId: 'summarization', slot: 'tools', toolBearing: true });
    if (!r.ok) throw new Error(`gap ${r.gap.code}`);
    expect(r.domain.singleOnly).toBe(true);
    const views = dialViews(r.domain);
    // The cascade (q 0.95, $0.006) captures serving's selection wherever
    // it is the cheapest qualifying point (the 0.9 rung: R $1.00 / K $1.15
    // vs cascade $0.006) — those positions are the typed refusal, because
    // a felt/run under them would serve the composite (and a tool-bearing
    // RUN would then 400). Rungs where a single still wins (the $0.004
    // cheap point under low floors) stay honestly feasible. The first
    // walkthrough run silently served the composite here; the
    // serve-agreement check makes that unrepresentable.
    const cascadeHash = strategyHash({
      type: 'cascade',
      stages: [{ model: 'gpt-mini-class' }, { model: 'frontier-class' }],
      confidenceMethod: 'self-report-calibrated',
    });
    let divergences = 0;
    for (const v of views) {
      if (v.feasible) {
        expect(v.strategyType).toBe('single');
      } else {
        expect(v.gap.code).toBe('serve-partition-divergence');
        if (v.gap.code === 'serve-partition-divergence') {
          expect(v.gap.capturedBy).toBe(cascadeHash);
          divergences += 1;
        }
      }
    }
    expect(divergences).toBeGreaterThanOrEqual(1); // the top rung at least
    // A FEASIBLE rung of the real domain (the cheap single undercuts the
    // cascade there): the felt call through the real route serves exactly
    // the single the view names — feasibility means serve-agreement, by
    // construction. (An earlier version of this leg fabricated a
    // singles-filtered world whose fullPoints hid the cascade; serving's
    // real frontier promptly served the cascade and failed the assertion —
    // the serve-agreement check must always see the REAL frontier.)
    const top = views.filter((v) => v.feasible).at(-1)!;
    if (!top.feasible) throw new Error('no feasible position on the real domain');
    const row = await materializeDialPolicy(h.db, {
      orgId: ORG, harnessHash: 'partitionwt0', slot: 'tools', policy: top.policy,
    });
    expect(row.name).toBe(dialPolicyName(ORG, 'partitionwt0', 'tools'));
    const felt = await feltSweep(
      [{ orgId: ORG, probe: missionProbe(MISSION), policy: top.policy, policyRef: row.name, frontierId: r.domain.frontierId }],
      feltDeps(),
    );
    const o = felt.samples[0]!.outcome;
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.sample.strategyHash8).toBe(top.strategyHash.slice(0, 8));
      expect(o.sample.strategyHash8).not.toBe(strategyHash({
        type: 'cascade',
        stages: [{ model: 'gpt-mini-class' }, { model: 'frontier-class' }],
        confidenceMethod: 'self-report-calibrated',
      }).slice(0, 8));
    }
  }, 120_000);
});


describe('Leg 5 — serving-measured latency substitution (the review scenario, executed)', () => {
  it('30+ measured samples flip the SAME rung from R to K in view AND felt, in agreement', async () => {
    // A CLEAN cluster for the flip (Leg 4 added a cascade to summarization,
    // which legitimately captures tool-free selection there): rewrite-edit
    // carries exactly the R/M/K world.
    await h.db.insert(clusters).values({
      id: 'rewrite-edit', name: 'rewrite-edit', description: 'Taxonomy cluster (walkthrough leg 5)',
    }).onConflictDoNothing();
    const rPoint = { ...P_R, clusterId: 'rewrite-edit' };
    const kPoint = { ...P_K, clusterId: 'rewrite-edit' };
    const mPoint = { ...P_M, clusterId: 'rewrite-edit' };
    await saveFrontier(h.db, 'rewrite-edit', [rPoint, mPoint, kPoint], 'recompute', 'pv-flip-wt');

    const domainFor = async () => {
      const ctx = await loadDialContext(h.db, { orgId: ORG, clusterId: 'rewrite-edit' });
      if (!ctx.ok) throw new Error(`context gap ${ctx.gap.code}`);
      const r = domainFromContext(ctx.context, { slot: 'brain', toolBearing: false });
      if (!r.ok) throw new Error(`gap ${r.gap.code}`);
      return r.domain;
    };

    // Before substitution: default tolerance shows R at the 0.9 rung.
    const before = await domainFor();
    expect(before.latencyBasis).toBe('harness');
    const topRung = before.ladder.indexOf(0.9 - 0.02); // the rung is the PROVEN bound (CI campaign)
    expect(topRung).toBeGreaterThanOrEqual(0);
    const beforeView = viewPosition(before, { qualityIndex: topRung });
    if (!beforeView.feasible) throw new Error('infeasible');
    expect(beforeView.strategyHash).toBe(P_R.strategyHash);

    // The org's measured traffic: 35 servings of R at ~2100ms — over the
    // dial's default tolerance. Serving substitutes this p95 before
    // selection; the context module sees exactly the same rollup.
    for (let i = 0; i < 35; i++) {
      await insertRequestLog(h.db, {
        orgId: ORG, clusterId: 'rewrite-edit', strategyHash: P_R.strategyHash,
        status: 'ok', latencyMs: 2100,
        usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
      });
    }
    const after = await domainFor();
    expect(after.latencyBasis).toBe('mixed'); // R serving-measured, others harness
    // HOLD the tolerance at its pre-substitution value: the default is
    // re-derived from the bound points and would stretch to re-admit R —
    // the flip is the story of a tolerance set when the world was faster.
    const afterView = viewPosition(after, {
      qualityIndex: after.ladder.indexOf(0.9 - 0.02),
      toleranceMs: before.defaultToleranceMs,
    });
    if (!afterView.feasible) throw new Error('infeasible');
    // R's substituted p95 (2100) exceeds the default tolerance → K wins the
    // SAME rung at the SAME frontier version: the silent production
    // divergence, now visible and agreed.
    expect(afterView.strategyHash).toBe(P_K.strategyHash);

    // The felt call under the same policy agrees — serving substitutes the
    // same rollup. A clean (non-divergent) K sample proves three-surface
    // agreement UNDER substitution.
    const row = await materializeDialPolicy(h.db, {
      orgId: ORG, harnessHash: 'lat-flip-wt0', slot: 'brain', policy: afterView.policy,
    });
    const felt = await feltSweep(
      [{ orgId: ORG, probe: missionProbe({ goal: 'Latency flip probe', doneDefinition: 'flip' }), policy: afterView.policy, policyRef: row.name, frontierId: after.frontierId, expectedStrategyHash: afterView.strategyHash }],
      feltDeps('rewrite-edit'),
    );
    const o = felt.samples[0]!.outcome;
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.divergent).toBeUndefined();
      expect(o.sample.strategyHash8).toBe(P_K.strategyHash.slice(0, 8));
      // Metered cost resolved through the production request_logs join.
      expect(o.sample.costUsd).not.toBeNull();
    }
  }, 120_000);
});
