// The Step 6 definition of done, walkthrough-style: a plain-language
// mission becomes a valid, RUNNABLE spec where every autopilot choice
// traces to a frontier point.
//
// Leg A (metering): the generator's extraction call goes through the REAL
// serving route — buildServer on an ephemeral port, actual metering. The
// mock provider does not speak extraction JSON, so the generation ends in
// the typed extraction-unparseable refusal at exactly the call bound —
// proving the metering join AND the bound with real traffic.
//
// Leg B (end to end): scripted extraction (the mock provider cannot emit
// schema JSON — same split as the Step 4 synthesis leg), REAL everything
// else: a live-evidenced platform frontier seeded through saveFrontier in
// the real db, autopilot fill with provenance traced to that row, spec
// assembly + lab-spec parse, then startRun executes the GENERATED spec
// against the real server to completion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@potion/core';
import {
  createDb,
  createOrg,
  insertApiKey,
  insertPolicy,
  migrate,
  requestLogs,
  type DbHandle,
} from '@potion/db';
import { loadCurrentFrontier, saveFrontier } from '@potion/pareto';
import type { FrontierPoint } from '@potion/core';
import { parseHarnessSpecText } from '@potion/lab-spec';
import { ServingClient, startRun } from '@potion/lab-runtime';
import type { ServingResult } from '@potion/lab-runtime';
import { buildServer } from '@potion/server/server';
import { eq } from 'drizzle-orm';
import { GEN_MAX_MODEL_CALLS } from './constants.js';
import { generateSpec, verifyChoicesBinding } from './generate.js';
import type { InterviewAnswers, TaxonomyCluster } from './interview.js';

const ORG = 'org_lab_gen_wt';
const RAW_KEY = 'pk_lab_gen_walkthrough_01';

let h: DbHandle;
// The server's own instance type — fastify is @potion/server's dependency,
// not this package's, so the type is derived from buildServer.
let app: Awaited<ReturnType<typeof buildServer>>;
let client: ServingClient;

const ANSWERS: InterviewAnswers = {
  goal: 'summarize my weekly meeting notes into a digest',
  kind: 'task',
  doneDefinition: 'a digest exists',
  accounts: [],
  worthUsd: 2,
};

function livePoint(hash: string, over: Partial<FrontierPoint> = {}): FrontierPoint {
  return {
    clusterId: 'summarization',
    strategyHash: hash,
    strategyConfig: { type: 'single', model: 'or-x' },
    quality: 0.87,
    costPer1K: 0.011,
    latencyP95: 750,
    providerMode: 'live',
    evidence: { cacheKeys: ['ck-wt'], runIds: ['run-wt'], n: 14, qualityCi95: 0.02, suiteContentHash: 'd'.repeat(64) },
    ...over,
  };
}

beforeAll(async () => {
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Gen Walkthrough Org' });
  await insertPolicy(h.db, {
    id: 'pol-lab-gen-wt', orgId: ORG, name: 'lab-gen-wt',
    config: { type: 'min_cost', qualityFloor: 0 },
  });
  await insertApiKey(h.db, {
    id: 'key-lab-gen-wt', keyHash: sha256(RAW_KEY), name: 'gen walkthrough',
    orgId: ORG, policyId: 'pol-lab-gen-wt', rateRps: 1000, dailyCap: 100_000,
  });
  // seed:true = the mock platform frontiers serving's fallback rides (the
  // Step 3 walkthrough arrangement). The seeded MOCK frontiers are for
  // serving the runtime's calls; Leg B's GENERATION frontier is the
  // separate live-evidenced 'summarization' row seeded in the test itself.
  app = await buildServer({ db: h, seed: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  client = new ServingClient({ baseUrl: `http://127.0.0.1:${addr.port}`, apiKey: RAW_KEY });
}, 120_000);

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('Leg A — the generator is a metered model call (real route)', () => {
  it('extraction meters as request_logs; a missing frontier is an honest draft, never a fabricated spec', async () => {
    const before = (await h.db.select().from(requestLogs).where(eq(requestLogs.orgId, ORG))).length;
    const r = await generateSpec(ANSWERS, {
      client,
      loadFrontier: async () => null,
    });
    // Step 8: the mock provider answers the extraction prompt with valid
    // JSON (the additive lab-extraction fixture — the $0 novice loop needs
    // a completable interview), so generation now proceeds PAST extraction
    // and stops honestly at the missing frontier: a DRAFT with the typed
    // frontier gap, never a spec invented without live evidence.
    expect(r.kind).toBe('draft');
    if (r.kind === 'draft') {
      expect(r.gaps.some((g) => g.code === 'frontier-missing' || g.code === 'frontier-not-live')).toBe(true);
    }
    const after = (await h.db.select().from(requestLogs).where(eq(requestLogs.orgId, ORG))).length;
    // ONE successful extraction call metered (the repair pass is unneeded
    // now that the first reply parses) — still within GEN_MAX_MODEL_CALLS.
    expect(after - before).toBe(1);
    expect(1).toBeLessThanOrEqual(GEN_MAX_MODEL_CALLS);
  }, 120_000);
});

describe('Leg B — intent → valid spec → running harness (DoD)', () => {
  it('generates from a seeded LIVE platform frontier, provenance traced, then RUNS to completion', async () => {
    // A live-evidenced platform frontier in the REAL db (the post-Step-5
    // situation), read back through the real loader.
    const saved = await saveFrontier(
      h.db,
      'summarization',
      [livePoint('wt-single-1'), livePoint('wt-single-2', { quality: 0.93, costPer1K: 0.05, latencyP95: 1400 })],
      'recompute',
      'pv-wt',
    );

    const extraction = JSON.stringify({
      normalizedGoal: 'Summarize the weekly meeting notes into a concise digest.',
      doneDefinition: 'A digest exists and covers every meeting.',
      nameSlug: 'weekly-digest',
      clusterHint: 'summarization',
    });
    const q = [extraction];
    const scripted = { complete: async () => ({
      kind: 'ok', completionId: 'chatcmpl-wt-1', text: q.shift() ?? '', toolCalls: [],
      finishReason: 'stop', usage: { promptTokens: 40, completionTokens: 30, totalTokens: 70 },
      frontierTrace: 't',
    } as ServingResult) } as unknown as ServingClient;

    const r = await generateSpec(ANSWERS, {
      client: scripted,
      loadFrontier: async (clusterId: TaxonomyCluster) => loadCurrentFrontier(h.db, clusterId),
    });
    expect(r.kind).toBe('complete');
    if (r.kind !== 'complete') return;

    // Every autopilot choice traces to the REAL frontier row.
    expect(r.sidecar.choices[0]!.basis.frontierId).toBe(saved.id);
    expect(r.sidecar.choices[0]!.basis.frontierVersion).toBe(saved.version);
    expect(['wt-single-1', 'wt-single-2']).toContain(r.sidecar.choices[0]!.basis.strategyHash);
    expect(r.sidecar.choices[0]!.basis.suiteContentHash).toBe('d'.repeat(64));
    expect(verifyChoicesBinding(r.specText, r.sidecar)).toEqual({ bound: true });
    expect(parseHarnessSpecText(r.specText).ok).toBe(true);

    // The generated file RUNS — the real runtime against the real route.
    const { outcome } = await startRun({
      db: h.db,
      client,
      orgId: ORG,
      specText: r.specText,
    });
    expect(outcome.status).toBe('completed');
  }, 120_000);
});
