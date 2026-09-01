// W-flagship — trial attachments: the operator's own data seeds the run
// workspace before the worker starts. Laws: files land whole (binary-safe
// base64); a bad path or oversize is a typed refusal BEFORE any job
// enqueues; the run reports what it carried.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { createMembership, createOrg, createSession, createUser, getLabRunFile, insertApiKey, listLabRunFiles } from '@potion/db';
import { buildServer } from '../src/server.js';

const ORG = 'org-attach';
let app: FastifyInstance;
let cookie = '';

beforeAll(async () => {
  app = await buildServer({ seed: true });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Attach Co' });
  await insertApiKey(db, { id: 'key-attach', keyHash: sha256('pk_attach'), name: 'k', orgId: ORG, scopes: 'serve' });
  await createUser(db, { id: 'usr_attach', email: 'a@attach.test', name: 'a' });
  await createMembership(db, { orgId: ORG, userId: 'usr_attach', role: 'admin' });
  await createSession(db, {
    id: 'ses_attach', userId: 'usr_attach', tokenHash: sha256('ps_attach'), orgId: ORG,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  cookie = 'potion_session=ps_attach';
});
afterAll(async () =>
  app.close());

async function hire(): Promise<string> {
  // Seed a harness row directly — generation is not under test here.
  const { upsertLabHarness } = await import('@potion/db');
  const { harnessSpecHash } = await import('@potion/lab-spec');
  const spec = {
    specVersion: 1 as const, name: 'attach harness',
    brain: { policy: { type: 'min_cost' as const, qualityFloor: 0 } },
    mission: { kind: 'task' as const, goal: 'analyze the attached file', doneDefinition: 'done' },
    superpowers: [], memory: { enabled: false as const }, rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true as const }, checkIns: [],
  };
  const hash = harnessSpecHash(spec);
  await upsertLabHarness(app.potion.db.db, {
    orgId: ORG, harnessHash: hash, name: spec.name,
    specText: JSON.stringify({ ...spec, hash }), sidecar: {}, clusterId: 'code-gen',
  });
  return hash;
}

describe('trial attachments', () => {
  it('a CSV attachment lands in the run workspace byte-identical, and the response names it', async () => {
    const hash = await hire();
    const csv = 'day,revenue\nMon,60.50\nTue,70.50\n';
    const res = await app.inject({
      method: 'POST', url: '/api/lab/runs', headers: { cookie },
      payload: { harnessHash: hash, attachments: [{ name: 'sales.csv', contentBase64: Buffer.from(csv).toString('base64') }] },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { runId: string; attached?: string[] };
    expect(body.attached).toEqual(['sales.csv']);
    const files = await listLabRunFiles(app.potion.db.db, ORG, body.runId);
    expect(files.map((f) => f.name)).toEqual(['sales.csv']);
    const stored = await getLabRunFile(app.potion.db.db, ORG, body.runId, 'sales.csv');
    expect(stored!.content.toString('utf8')).toBe(csv);
  });

  it('a path-escaping name is refused typed, before any job exists', async () => {
    const hash = await hire();
    const res = await app.inject({
      method: 'POST', url: '/api/lab/runs', headers: { cookie },
      payload: { harnessHash: hash, attachments: [{ name: '../../etc/passwd', contentBase64: Buffer.from('x').toString('base64') }] },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('attachment_refused');
  });
});
