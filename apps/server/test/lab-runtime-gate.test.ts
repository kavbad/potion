// L-G4 gate tests: the pore over HTTP with a serving key. The contract:
// bearer-only auth, idempotent sessions, supervised holds that become
// evidence through the SAME extractor the hosted loop feeds, earned
// autonomy that skips the pore, blocked classes that refuse, and uniform
// cross-org 404s on body-carried run ids.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  acceptGraduation,
  createOrg,
  ensureActionGrant,
  insertApiKey,
  listActionGrants,
  listLabStepsForHarness,
  upsertLabHarness,
} from '@potion/db';
import { extractPoreEvidence } from '@potion/lab-runtime';
import type { StepPayload } from '@potion/lab-runtime';
import { buildServer } from '../src/server.js';

const ORG_A = 'org_gate_a';
const ORG_B = 'org_gate_b';
const KEY_A = 'pk_gate_a';
const KEY_B = 'pk_gate_b';
const HASH = 'ef'.repeat(32);

let app: FastifyInstance;
const db = () => app.potion.db.db;
const authA = { authorization: `Bearer ${KEY_A}` };

async function post(url: string, payload: Record<string, unknown>, headers = authA) {
  return app.inject({ method: 'POST', url, headers, payload });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  for (const [org, key] of [[ORG_A, KEY_A], [ORG_B, KEY_B]] as const) {
    await createOrg(db(), { id: org, name: org });
    await insertApiKey(db(), { id: `key-${org}`, keyHash: sha256(key), name: org, orgId: org, scopes: 'serve' });
  }
  await upsertLabHarness(db(), {
    orgId: ORG_A,
    harnessHash: HASH,
    name: 'gate harness',
    specText: JSON.stringify({}),
    sidecar: { specHash: HASH, choicesHash: 'x', choices: [] },
    clusterId: 'code-gen',
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('the runtime gate', () => {
  let runId = '';

  it('rejects missing keys; registers sessions idempotently', async () => {
    const anon = await app.inject({ method: 'POST', url: '/v1/lab/runtime/sessions', payload: { harnessHash: HASH, sessionKey: 's1' } });
    expect(anon.statusCode).toBe(401);
    const one = await post('/v1/lab/runtime/sessions', { harnessHash: HASH, sessionKey: 's1' });
    expect(one.statusCode).toBe(200);
    runId = (one.json() as { runId: string }).runId;
    const two = await post('/v1/lab/runtime/sessions', { harnessHash: HASH, sessionKey: 's1' });
    expect((two.json() as { runId: string }).runId).toBe(runId); // deterministic id
  });

  it('a supervised action HOLDs with a fingerprint-bound check-in, and the resolution becomes pore evidence', async () => {
    const pore = await post('/v1/lab/runtime/pore', { runId, toolName: 'email:send', argsHash: 'h-1', argsSummary: '{"to":"a@b.c"}' });
    expect((pore.json() as { decision: string }).decision).toBe('hold');
    const resolve = await post('/v1/lab/runtime/pore/resolve', { runId, argsHash: 'h-1', resolution: 'allow-once' });
    expect((resolve.json() as { recorded: boolean }).recorded).toBe(true);
    const steps = await listLabStepsForHarness(db(), ORG_A, HASH);
    const evidence = extractPoreEvidence(steps.map((s) => ({ payload: s.payload as StepPayload, createdAt: s.createdAt })));
    expect(evidence.get('email:send')!.map((e) => e.outcome)).toEqual(['approved']);
    // The grant row was born supervised, fail-closed to irreversible-act
    // ('email:send' is not in the superpower catalog).
    const grants = await listActionGrants(db(), ORG_A, HASH);
    expect(grants.find((g) => g.actionClass === 'email:send')!.riskTier).toBe('irreversible-act');
  });

  it('timeout resolutions record NOTHING — unanswered says nothing', async () => {
    await post('/v1/lab/runtime/pore', { runId, toolName: 'email:send', argsHash: 'h-2' });
    await post('/v1/lab/runtime/pore/resolve', { runId, argsHash: 'h-2', resolution: 'timeout' });
    const steps = await listLabStepsForHarness(db(), ORG_A, HASH);
    const evidence = extractPoreEvidence(steps.map((s) => ({ payload: s.payload as StepPayload, createdAt: s.createdAt })));
    expect(evidence.get('email:send')!).toHaveLength(1); // still just the first
  });

  it('an earned-autonomous class ALLOWs without a pore; outcomes record as tool steps', async () => {
    const grant = await ensureActionGrant(db(), { orgId: ORG_A, harnessHash: HASH, actionClass: 'crm:lookup', riskTier: 'reversible-read' });
    await acceptGraduation(db(), grant.id, { auditRate: 1 }); // audit=1 → deterministic sample flag
    const pore = await post('/v1/lab/runtime/pore', { runId, toolName: 'crm:lookup', argsHash: 'h-3' });
    const body = pore.json() as { decision: string; audit: boolean };
    expect(body.decision).toBe('allow');
    expect(body.audit).toBe(true);
    const before = (await listLabStepsForHarness(db(), ORG_A, HASH)).length;
    await post('/v1/lab/runtime/outcome', { runId, toolName: 'crm:lookup', argsHash: 'h-3', ok: true, fromAudit: true });
    const after = await listLabStepsForHarness(db(), ORG_A, HASH);
    expect(after.length).toBe(before + 1);
    expect((after[after.length - 1]!.payload as StepPayload).toolOutput).toBe('executed');
  });

  it('cross-org run ids 404 uniformly; a foreign harness cannot even register', async () => {
    const foreignPore = await post('/v1/lab/runtime/pore', { runId, toolName: 'x', argsHash: 'h' }, { authorization: `Bearer ${KEY_B}` });
    expect(foreignPore.statusCode).toBe(404);
    const foreignSession = await post('/v1/lab/runtime/sessions', { harnessHash: HASH, sessionKey: 's1' }, { authorization: `Bearer ${KEY_B}` });
    expect(foreignSession.statusCode).toBe(404);
  });
});
