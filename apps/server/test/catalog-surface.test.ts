// The CATALOG SURFACE (Step 11 §8) — GET /api/lab/connectors serves every
// catalog package with its honest tier, connect posture, read/act split, and
// least-privilege defaults, ALONGSIDE the Step 10 grant badge states.
//
// The two claims are deliberately separate fields: `tier` (what the
// mini-eval proved) and `status` (whether THIS org holds a live grant). A
// package can be fixture-proven and not connected; connected and only
// fixture-authored. The surface never merges them into one green dot.
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import {
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertApiKey,
  insertPolicy,
  markLabGrantStatus,
  upsertLabGrant,
} from '@potion/db';
import { CATALOG } from '@potion/lab-superpowers';
import { buildServer } from '../src/server.js';

const ORG = 'org_catalog';
const KEY = 'pk_catalog_admin';
const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let app: FastifyInstance;
let tmpRoot: string;
let devAuthBefore: string | undefined;

interface ConnectorRow {
  connectorId: string;
  displayName: string;
  tier: string;
  connectStatus: string;
  connectNote: string | null;
  defaultScopes: string[];
  toolCount: { read: number; act: number };
  tools: Array<{ name: string; action: string }>;
  contextTokens: number;
  configured: boolean;
  status: string;
  fixtureAgeDays: number | null;
}

async function connectors(): Promise<ConnectorRow[]> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/lab/connectors',
    headers: { authorization: `Bearer ${KEY}` },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { connectors: ConnectorRow[] }).connectors;
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'potion-catalog-'));
  copyFileSync(REPO_PRICES, path.join(tmpRoot, 'prices.json'));
  process.env.POTION_PRICES_PATH = path.join(tmpRoot, 'prices.json');
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: ORG });
  await insertPolicy(db, { id: `pol-${ORG}`, orgId: ORG, name: 'p', config: { type: 'min_cost', qualityFloor: 0 } });
  await insertApiKey(db, {
    id: `key-${ORG}`, keyHash: sha256(KEY), name: 'k', orgId: ORG,
    policyId: `pol-${ORG}`, scopes: 'serve+admin',
  });
  await createUser(db, { id: 'usr_catalog', email: 'c@c.dev', name: 'c' });
  await createMembership(db, { orgId: ORG, userId: 'usr_catalog', role: 'admin' });
  await createSession(db, {
    id: 'ses-catalog', userId: 'usr_catalog', tokenHash: sha256('ps_catalog'),
    orgId: ORG, expiresAt: new Date(Date.now() + 3_600_000),
  });
}, 120_000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GET /api/lab/connectors — the catalog', () => {
  it('serves every catalog package with tier, posture, read/act split and least-privilege defaults', async () => {
    const rows = await connectors();
    expect(rows.length).toBe(CATALOG.length);
    expect(rows.length).toBeGreaterThanOrEqual(25);
    for (const row of rows) {
      const pkg = CATALOG.find((p) => p.id === row.connectorId)!;
      expect(pkg, `unknown connector ${row.connectorId}`).toBeDefined();
      expect(row.tier).toBe(pkg.proof);
      expect(row.connectStatus).toBe(pkg.connect.status);
      expect(row.defaultScopes).toEqual(pkg.defaultScopes);
      expect(row.toolCount.read + row.toolCount.act).toBe(pkg.tools.length);
      expect(row.contextTokens).toBeGreaterThan(0);
      // every tool carries its classification on the surface
      expect(row.tools.every((t) => t.action === 'read' || t.action === 'act')).toBe(true);
    }
  });

  it('TIER and grant STATUS are separate claims — never merged', async () => {
    const rows = await connectors();
    // no live-proven package today; every row is fixture-authored…
    expect(new Set(rows.map((r) => r.tier))).toEqual(new Set(['fixture-authored']));
    // …and none is connected for this org yet
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['not-connected']));
    // fields exist independently
    const github = rows.find((r) => r.connectorId === 'github')!;
    expect(github.tier).toBe('fixture-authored');
    expect(github.status).toBe('not-connected');
    expect(github.connectStatus).toBe('ready'); // connectable ≠ live-proven
  });

  it('unconnectable packages say WHY, and are not merely "unconfigured"', async () => {
    const rows = await connectors();
    const unconnectable = rows.filter((r) => r.connectStatus !== 'ready');
    expect(unconnectable.length).toBeGreaterThan(0);
    for (const row of unconnectable) {
      expect(row.connectNote, `${row.connectorId} gives no reason`).toBeTruthy();
      expect(row.configured).toBe(false); // cannot be connected at all
    }
    const ready = rows.filter((r) => r.connectStatus === 'ready');
    expect(ready.map((r) => r.connectorId).sort()).toEqual(['github', 'linear', 'notion']);
  });

  it('the Step 10 BADGE STATES ride the catalog: not-connected → connected → revoked', async () => {
    const db = app.potion.db.db;
    const before = (await connectors()).find((r) => r.connectorId === 'github')!;
    expect(before.status).toBe('not-connected');

    await upsertLabGrant(db, {
      id: 'grant-catalog', orgId: ORG, connectorId: 'github', superpowerId: 'github',
      scopesGranted: [], tokenEnvelope: await app.potion.custody.encryptKey('gho_catalogTEST123456789'),
      grantedBy: 'usr_catalog',
    });
    const connected = (await connectors()).find((r) => r.connectorId === 'github')!;
    expect(connected.status).toBe('connected');
    expect(connected.tier).toBe('fixture-authored'); // the tier did NOT move

    await markLabGrantStatus(db, ORG, 'github', 'revoked');
    const revoked = (await connectors()).find((r) => r.connectorId === 'github')!;
    expect(revoked.status).toBe('revoked');
  });

  it('no token material rides the catalog surface (the Step 10 rule, re-proven here)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/lab/connectors', headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.body).not.toContain('gho_catalogTEST');
    expect(res.body).not.toContain('tokenEnvelope');
    expect(res.body).not.toContain('token_envelope');
  });

  it('an unconnectable package REFUSES the OAuth start (structural, not advisory)', async () => {
    const unverified = CATALOG.find((p) => p.connect.status !== 'ready')!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/lab/connectors/${unverified.id}/oauth/start`,
      headers: { authorization: `Bearer ${KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404); // it does not compile to a connector
  });
});
