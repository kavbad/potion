// Step 10 custody enforcement 3 — the INVENTORY-DRIVEN token-absence sweep.
//
// A grant's sealed tokens must be structurally unreadable through ANY API
// response. This sweep does not trust a hand-list of "grant-touching
// routes": it drives EVERY row of ROUTE_INVENTORY — whose own completeness
// meta-test (key-role-split.test.ts) fails the moment a live route is
// missing from it — against an org holding a REAL sealed grant, and
// asserts the canary token is absent from every response body in every
// encoding, along with the envelope text and the envelope column names.
// A future route cannot dodge this sweep by not being listed in a test
// file: to exist at all it must enter the inventory, and entering the
// inventory enrolls it here (review addition 2).
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
  upsertLabGrant,
} from '@potion/db';
import { buildServer } from '../src/server.js';
import { ROUTE_INVENTORY, type RouteInventoryRow } from '../src/security/route-inventory.js';

const ORG = 'org_grantsweep';
const KEY = 'pk_grantsweep_admin';
const COOKIE = 'potion_session=ps_grantsweep';
const CANARY = 'gho_ABSENCEcanary4X9mQ2vL7pK8rT3sW6zE1yN';
const REFRESH_CANARY = 'ghr_ABSENCEcanary8B2nC4xZ6aS0dF1gH3jK5lQ';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let app: FastifyInstance;
let tmpRoot: string;
let devAuthBefore: string | undefined;
let tokenEnvelope: string;
let refreshEnvelope: string;

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0';
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'potion-grantsweep-'));
  const tmpPrices = path.join(tmpRoot, 'prices.json');
  copyFileSync(REPO_PRICES, tmpPrices);
  process.env.POTION_PRICES_PATH = tmpPrices;

  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: ORG });
  await insertPolicy(db, {
    id: `pol-${ORG}`,
    orgId: ORG,
    name: 'p',
    config: { type: 'min_cost', qualityFloor: 0 },
  });
  await insertApiKey(db, {
    id: `key-${ORG}`,
    keyHash: sha256(KEY),
    name: 'k',
    orgId: ORG,
    policyId: `pol-${ORG}`,
    scopes: 'serve+admin', // admin routes must answer with DATA, not 403
  });
  await createUser(db, { id: 'usr_grantsweep', email: 'usr_grantsweep@sweep.dev', name: 'gs' });
  await createMembership(db, { orgId: ORG, userId: 'usr_grantsweep', role: 'admin' });
  await createSession(db, {
    id: 'sess-grantsweep',
    userId: 'usr_grantsweep',
    tokenHash: sha256('ps_grantsweep'),
    orgId: ORG,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  // The grant: sealed under the SERVER'S OWN live master key — a fully
  // decryptable row, exactly what production holds. If any route can
  // surface it, this sweep sees it.
  tokenEnvelope = await app.potion.custody.encryptKey(CANARY);
  refreshEnvelope = await app.potion.custody.encryptKey(REFRESH_CANARY);
  await upsertLabGrant(db, {
    id: 'grant-absence-1',
    orgId: ORG,
    connectorId: 'github',
    superpowerId: 'github',
    scopesGranted: ['read'],
    tokenEnvelope,
    refreshEnvelope,
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    grantedBy: 'usr_grantsweep',
  });
}, 120_000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Every disguise the redactor also knows, plus the envelope machinery
 * itself: the sealed text and the column names. */
function forbiddenStrings(): Array<[string, string]> {
  const forms: Array<[string, string]> = [];
  for (const [label, secret] of [
    ['access token', CANARY],
    ['refresh token', REFRESH_CANARY],
  ] as const) {
    forms.push(
      [`${label} (raw)`, secret],
      [`${label} (base64)`, Buffer.from(secret).toString('base64')],
      [`${label} (base64url)`, Buffer.from(secret).toString('base64url')],
      [`${label} (base64, unpadded)`, Buffer.from(secret).toString('base64').replace(/=+$/, '')],
      [`${label} (url-encoded)`, encodeURIComponent(secret)],
      // Step 12 (pass 1): HEX was missing here. The Step 10 review added hex
      // to the redactor precisely because a hosted server that hex-encodes
      // the bearer evaded the original set — but this sweep, whose own test
      // name promises "in any encoding", never looked for it. An instrument
      // that does not measure what its sentence claims is the shape this
      // build keeps finding; the encodings are now derived from the SAME
      // list the redactor scrubs, so the two cannot drift apart again.
      [`${label} (hex)`, Buffer.from(secret).toString('hex')],
      [`${label} (hex, upper)`, Buffer.from(secret).toString('hex').toUpperCase()],
    );
  }
  forms.push(
    ['token envelope text', tokenEnvelope],
    ['refresh envelope text', refreshEnvelope],
    ['envelope column (snake)', 'token_envelope'],
    ['envelope column (camel)', 'tokenEnvelope'],
    ['refresh column (snake)', 'refresh_envelope'],
    ['refresh column (camel)', 'refreshEnvelope'],
  );
  return forms;
}

function probeUrlFor(row: RouteInventoryRow): string {
  if (row.probeUrl !== undefined) return row.probeUrl;
  return row.path
    .replace(/:hash\b/g, '0'.repeat(64))
    .replace(/:[A-Za-z]+/g, 'sweep-probe-id');
}

describe('inventory-driven grant-absence sweep', () => {
  it('EVERY inventoried route answers without token material, in any encoding, under both credentials', async () => {
    expect(ROUTE_INVENTORY.length).toBeGreaterThan(60); // never vacuous
    const forbidden = forbiddenStrings();
    let driven = 0;
    for (const row of ROUTE_INVENTORY) {
      const url = probeUrlFor(row);
      for (const creds of [
        { authorization: `Bearer ${KEY}` },
        { cookie: COOKIE },
      ]) {
        const res = await app.inject({
          method: row.method,
          url,
          headers: creds,
          ...(row.method !== 'GET' ? { payload: row.probeBody ?? {} } : {}),
        });
        driven += 1;
        const body = res.body;
        for (const [label, needle] of forbidden) {
          expect(
            body.includes(needle),
            `${row.method} ${url} leaked the ${label} (status ${res.statusCode})`,
          ).toBe(false);
        }
      }
    }
    expect(driven).toBe(ROUTE_INVENTORY.length * 2);
  }, 240_000);

  /** The sweep itself drives POST /revoke (it drives everything) — re-grant
   * so the shape tests see a fresh active row. A re-grant REPLACES (repo
   * contract), so this is the ordinary reconnect path, not test trickery. */
  async function regrant(): Promise<void> {
    await upsertLabGrant(app.potion.db.db, {
      id: 'grant-absence-1',
      orgId: ORG,
      connectorId: 'github',
      superpowerId: 'github',
      scopesGranted: ['read'],
      tokenEnvelope,
      refreshEnvelope,
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      grantedBy: 'usr_grantsweep',
    });
  }

  it('GET /api/lab/connectors returns STATUS-shaped grants: derived status present, no envelope-shaped key anywhere', async () => {
    await regrant();
    const res = await app.inject({
      method: 'GET',
      url: '/api/lab/connectors',
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      connectors: Array<{ connectorId: string; status: string; grant: Record<string, unknown> | null }>;
    };
    const github = body.connectors.find((c) => c.connectorId === 'github')!;
    expect(github.status).toBe('connected');
    expect(Object.keys(github.grant!).sort()).toEqual([
      'createdAt',
      'grantedBy',
      'revokedAt',
      'scopesGranted',
      'tokenExpiresAt',
    ]);
  });

  it('the harness + run DTO posture derives from the grant (connected), and revocation shows the cut', async () => {
    await regrant();
    const db = app.potion.db.db;
    const { upsertLabHarness, markLabGrantStatus } = await import('@potion/db');
    const spec = {
      specVersion: 1,
      name: 'grant posture harness',
      brain: { policy: { type: 'min_cost', qualityFloor: 0 } },
      mission: { kind: 'task', goal: 'g', doneDefinition: 'd' },
      superpowers: [{ id: 'github', scopes: ['read'] }],
      memory: { enabled: false },
      rules: [],
      fuel: { maxUsdPerRun: 1, hardStop: true },
      checkIns: [],
    };
    const { harnessSpecHash } = await import('@potion/lab-spec');
    const hash = harnessSpecHash(spec as never);
    await upsertLabHarness(db, {
      orgId: ORG,
      harnessHash: hash,
      name: 'grant posture harness',
      specText: JSON.stringify(spec),
      sidecar: { specHash: hash, choicesHash: 'x', choices: [] },
      clusterId: 'code-gen',
    });
    const before = await app.inject({
      method: 'GET',
      url: `/api/lab/harnesses/${hash}`,
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect((before.json() as { superpowers: Array<{ status: string }> }).superpowers[0]!.status).toBe(
      'connected',
    );
    await markLabGrantStatus(db, ORG, 'github', 'revoked');
    const after = await app.inject({
      method: 'GET',
      url: `/api/lab/harnesses/${hash}`,
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect((after.json() as { superpowers: Array<{ status: string }> }).superpowers[0]!.status).toBe(
      'revoked',
    );
  });
});
