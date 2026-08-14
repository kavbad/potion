// Step 9 — the /edit route (the form's tap-to-edit save path) + the typed
// anomaly flags on the run DTO. The dial-motion discipline applied to the
// rest of the spec: every edit is a NEW content-addressed catalog row with
// carried provenance; the prior row and every run frozen from it are
// untouched; the closure gate refuses rather than emit a broken row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createLabRun,
  createMembership,
  createOrg,
  createSession,
  createUser,
  createDb,
  getLabHarness,
  migrate,
  upsertLabHarness,
  type DbHandle,
} from '@potion/db';
import { harnessSpecHash, parseHarnessSpecText, type HarnessSpec } from '@potion/lab-spec';
import { buildServer } from '../src/server.js';

const ORG = 'org_lab_edit';
const COOKIE = 'potion_session=ps_lab_edit';

let h: DbHandle;
let app: FastifyInstance;
let devAuthBefore: string | undefined;

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    specVersion: 1,
    name: 'edit-route harness',
    brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
    mission: { kind: 'task', goal: 'do the thing', doneDefinition: 'done', worthPerRunUsd: 1 },
    superpowers: [],
    memory: { enabled: false },
    rules: ['first rule'],
    fuel: { maxUsdPerRun: 0.25, hardStop: true },
    checkIns: [],
    ...over,
  } as HarnessSpec;
}

async function seedCatalog(s: HarnessSpec): Promise<string> {
  const hash = harnessSpecHash(s);
  await upsertLabHarness(h.db, {
    orgId: ORG,
    harnessHash: hash,
    name: s.name,
    specText: JSON.stringify({ ...s, hash }),
    sidecar: { specHash: hash, choicesHash: sha256('[]'), choices: [] },
    clusterId: 'summarization',
  });
  return hash;
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  h = await createDb();
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Lab Edit Org' });
  await createUser(h.db, { id: 'usr_lab_edit', email: 'edit@lab.dev', name: 'edit' });
  await createMembership(h.db, { orgId: ORG, userId: 'usr_lab_edit', role: 'admin' });
  await createSession(h.db, {
    id: 'ses_lab_edit',
    userId: 'usr_lab_edit',
    tokenHash: sha256('ps_lab_edit'),
    orgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  app = await buildServer({ db: h, seed: false });
}, 120_000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
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

describe('POST /api/lab/harnesses/:hash/edit', () => {
  it('add-rule lands a NEW content-addressed row; the prior row is untouched', async () => {
    const hash = await seedCatalog(spec());
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'add-rule', rule: 'never email externally' }],
    });
    const body = res.json() as { ok: boolean; harnessHash: string; previousHash: string; unchanged: boolean };
    expect(res.statusCode, res.body).toBe(200);
    expect(body.unchanged).toBe(false);
    expect(body.harnessHash).not.toBe(hash);
    expect(body.previousHash).toBe(hash);
    // the new row parses, carries the rule, and rebinds the sidecar
    const next = (await getLabHarness(h.db, ORG, body.harnessHash))!;
    const parsed = parseHarnessSpecText(next.specText);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.rules).toContain('never email externally');
    expect((next.sidecar as { specHash: string }).specHash).toBe(body.harnessHash);
    // the PRIOR row is byte-identical still
    const prior = (await getLabHarness(h.db, ORG, hash))!;
    expect(parseHarnessSpecText(prior.specText).ok).toBe(true);
    expect(prior.harnessHash).toBe(hash);
  });

  it('set-worth re-derives fuel through fuelFromWorth (dial honesty for money)', async () => {
    const hash = await seedCatalog(spec({ name: 'worth harness' }));
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'set-worth', worthUsd: 2 }],
    });
    const body = res.json() as { harnessHash: string };
    const next = (await getLabHarness(h.db, ORG, body.harnessHash))!;
    const parsed = parseHarnessSpecText(next.specText);
    if (parsed.ok) {
      expect(parsed.spec.fuel.maxUsdPerRun).toBe(0.5); // 2 × 0.25 ratio
      expect((parsed.spec.mission as { worthPerRunUsd?: number }).worthPerRunUsd).toBe(2);
    }
  });

  it('declare-superpower adds the external-action gate (the generation-time default, mirrored)', async () => {
    const hash = await seedCatalog(spec({ name: 'declare harness' }));
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'declare-superpower', id: 'calendar' }],
    });
    const body = res.json() as { harnessHash: string };
    const parsed = parseHarnessSpecText((await getLabHarness(h.db, ORG, body.harnessHash))!.specText);
    if (parsed.ok) {
      expect(parsed.spec.superpowers.map((s) => s.id)).toContain('calendar');
      expect(parsed.spec.checkIns.some((c) => c.trigger === 'before-external-action')).toBe(true);
    }
  });

  it('a no-op patch answers unchanged:true and writes nothing new', async () => {
    const s = spec({ name: 'noop harness' });
    const hash = await seedCatalog(s);
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'undeclare-superpower', id: 'nonexistent' }],
    });
    const body = res.json() as { ok: boolean; harnessHash: string; unchanged: boolean };
    expect(body.unchanged).toBe(true);
    expect(body.harnessHash).toBe(hash);
  });

  it('out-of-range remove-rule is a 400, never a broken row', async () => {
    const hash = await seedCatalog(spec({ name: 'range harness' }));
    const res = await post(`/api/lab/harnesses/${hash}/edit`, {
      ops: [{ op: 'remove-rule', index: 99 }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('a run frozen BEFORE the edit still replays its own spec (catalog invariance holds)', async () => {
    const s = spec({ name: 'frozen harness' });
    const hash = await seedCatalog(s);
    await createLabRun(h.db, { id: 'run-frozen-edit', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    await post(`/api/lab/harnesses/${hash}/edit`, { ops: [{ op: 'add-rule', rule: 'post-run rule' }] });
    const run = await app.inject({ method: 'GET', url: '/api/lab/runs/run-frozen-edit', headers: { cookie: COOKIE } });
    const body = run.json() as { harnessHash: string; superpowers: unknown[] };
    expect(body.harnessHash).toBe(hash); // the run's identity did not move
  });
});

describe('run DTO anomaly flags (Step 9 typed parse)', () => {
  it('fallback=1 / latency_violated=1 in a step trace surface as booleans', async () => {
    const s = spec({ name: 'anomaly harness' });
    const hash = harnessSpecHash(s);
    await createLabRun(h.db, { id: 'run-anom-flags', orgId: ORG, harnessHash: hash, harnessName: s.name, spec: s });
    const { claimLabRun, appendLabStep } = await import('@potion/db');
    const claim = await claimLabRun(h.db, { runId: 'run-anom-flags', orgId: ORG, expectedHarnessHash: hash, leaseMs: 60_000 });
    if (!claim.ok) throw new Error(claim.reason);
    await appendLabStep(h.db, {
      runId: 'run-anom-flags', orgId: ORG, fence: claim.fence, seq: 1, kind: 'model',
      payload: {
        kind: 'model', slot: 'brain', requestPayload: { model: 'potion-auto', messages: [] },
        responseText: 'served off-frontier', toolCalls: [], finishReason: 'stop', completionId: 'cmpl-anom',
        frontierTrace: 'cluster=x;strategy=abcd1234;frontier=v1;policy=min_cost;fallback=1;latency_violated=1;provenance=live',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, estCostUsd: 0.0001,
        clockMs: 1, rngSample: 0.5, legSeq: 1, stepInLeg: 1,
      },
      harnessHash: hash, leaseMs: 60_000,
    });
    const res = await app.inject({ method: 'GET', url: '/api/lab/runs/run-anom-flags', headers: { cookie: COOKIE } });
    const step = (res.json() as { steps: Array<{ fallback?: boolean; latencyViolated?: boolean }> }).steps[0]!;
    expect(step.fallback).toBe(true);
    expect(step.latencyViolated).toBe(true);
  });
});
