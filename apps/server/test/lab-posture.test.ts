// Step 8 — TOOL POSTURE PRE-MCP, the "three places" pin: a tool-bearing
// mission whose trial completes brain-only says so (typed, never a bare UI
// string) in the HARNESS DTO, the RUN DTO, and the REPORT's struggle
// section — and the report's single upgrade slot prefers "connect X".
// Driven end-to-end through the real routes: interview → catalog → trial
// run (lab:run worker over real HTTP with its ephemeral key) → report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash } from '@potion/core';
import {
  clusters,
  createDb,
  createMembership,
  createOrg,
  createSession,
  createUser,
  migrate,
  type DbHandle,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const ORG = 'org_lab_posture';
const COOKIE = 'potion_session=ps_lab_posture';

let h: DbHandle;
let app: FastifyInstance;
let devAuthBefore: string | undefined;
let servingUrlBefore: string | undefined;

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Posture Org' });
  await createUser(h.db, { id: 'usr_lab_posture', email: 'posture@lab.dev', name: 'posture' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_lab_posture', role: 'admin' });
  await createSession(h.db, {
    id: 'ses_lab_posture',
    userId: 'usr_lab_posture',
    tokenHash: sha256('ps_lab_posture'),
    orgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  // The generator's world: a live-evidenced platform frontier (Step 5's
  // product) for the cluster the goal maps to.
  await h.db
    .insert(clusters)
    .values({ id: 'summarization', name: 'summarization', description: 'taxonomy cluster' })
    .onConflictDoNothing();
  const config = { type: 'single' as const, model: 'mock-cheap' };
  await saveFrontier(
    h.db,
    'summarization',
    [
      {
        clusterId: 'summarization',
        strategyHash: strategyHash(config),
        strategyConfig: config,
        quality: 0.85,
        costPer1K: 0.012,
        latencyP95: 700,
        providerMode: 'live',
        evidence: { cacheKeys: ['ck-posture'], runIds: ['run-posture'], n: 12, qualityCi95: 0.02 },
      },
    ],
    'recompute',
    'pv-posture',
  );
  app = await buildServer({ db: h, seed: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  // The lab:run worker serves through THIS server's real route.
  servingUrlBefore = process.env.POTION_SERVING_URL;
  process.env.POTION_SERVING_URL = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  if (servingUrlBefore === undefined) delete process.env.POTION_SERVING_URL;
  else process.env.POTION_SERVING_URL = servingUrlBefore;
  await app.close();
  await h.close();
});

function post(url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie: COOKIE, 'content-type': 'application/json' },
    payload: payload as Record<string, unknown>,
  });
}

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: COOKIE } });
}

describe('tool posture — not-connected in all three places', () => {
  it('interview with a declared account → harness, run, and report all carry the typed posture', async () => {
    // 1. The interview declares an account it cannot yet execute.
    const gen = await post('/api/lab/harnesses', {
      answers: {
        goal: 'Summarize my meeting notes into a digest and file it',
        kind: 'task',
        doneDefinition: 'a digest exists',
        accounts: ['calendar'],
        worthUsd: 1,
      },
    });
    const genBody = gen.json() as { kind: string; harnessHash: string };
    expect(gen.statusCode, gen.body).toBe(201);
    expect(genBody.kind).toBe('complete');
    const hash = genBody.harnessHash;

    // PLACE 1: the harness DTO — typed status, not a UI string.
    const det = get(await Promise.resolve(`/api/lab/harnesses/${hash}`));
    const detBody = (await det).json() as {
      superpowers: Array<{ id: string; status: string }>;
    };
    expect(detBody.superpowers).toHaveLength(1);
    expect(detBody.superpowers[0]!.status).toBe('not-connected');

    // 2. The trial run — brain-only by construction (no toolDefs pre-MCP).
    const start = await post('/api/lab/runs', { harnessHash: hash });
    expect(start.statusCode, start.body).toBe(202);
    const runId = (start.json() as { runId: string }).runId;
    // The memory queue executes in-process; poll briefly to terminal.
    let runBody: {
      state: string;
      superpowers: Array<{ id: string; status: string }>;
      steps: Array<{ kind: string; slot: string | null; costLabel?: string }>;
    } = { state: 'pending', superpowers: [], steps: [] };
    const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);
    for (let i = 0; i < 120 && !TERMINAL.has(runBody.state); i++) {
      runBody = (await get(`/api/lab/runs/${runId}`)).json() as typeof runBody;
      if (!TERMINAL.has(runBody.state)) await new Promise((r) => setTimeout(r, 250));
    }
    expect(runBody.state).toBe('completed');

    // PLACE 2: the run DTO — same typed posture; every model step is
    // brain-slot (no tools were ever passed) and cost-labeled.
    expect(runBody.superpowers).toEqual([
      expect.objectContaining({ id: 'calendar', status: 'not-connected' }),
    ]);
    const modelSteps = runBody.steps.filter((s) => s.kind === 'model');
    expect(modelSteps.length).toBeGreaterThanOrEqual(1);
    for (const s of modelSteps) {
      expect(s.slot).toBe('brain');
      expect(['metered', 'est.']).toContain(s.costLabel);
    }

    // PLACE 3: the report — the struggle is recorded AND wins the single
    // upgrade slot ("connect X" beats everything on the ladder).
    const rep = (await get(`/api/lab/runs/${runId}/report`)).json() as {
      struggles: Array<{ code: string; superpowers?: string[] }>;
      suggestedUpgrade: { reason: string; text: string };
    };
    const posture = rep.struggles.find((s) => s.code === 'not-connected-superpowers');
    expect(posture).toBeDefined();
    expect(posture!.superpowers).toEqual(['calendar']);
    expect(rep.suggestedUpgrade.reason).toBe('not-connected-superpowers');
    expect(rep.suggestedUpgrade.text).toContain('calendar');
  }, 120_000);

  it('clusterChoice is schema-known and enum-bound (the answerable draft loop)', async () => {
    // A junk value must fail the ENUM, not pass the strict schema silently
    // or 400 as an unknown key — this pins the field into the contract.
    const bad = await post('/api/lab/harnesses', {
      answers: {
        goal: 'Summarize my meeting notes',
        kind: 'standing',
        accounts: [],
        worthUsd: 1,
        clusterChoice: 'not-a-cluster',
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('clusterChoice');
  });
});
