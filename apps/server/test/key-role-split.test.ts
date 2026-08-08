// G2.3 KEY ROLE SPLIT — the exhaustive proof (owner requirement: an
// enumerated inventory, not spot-checks).
//   · COMPLETENESS: the ROUTE_INVENTORY fixture must match the live fastify
//     route tree BOTH ways — a route added without classification fails this
//     suite by name (the 20th admin site next month cannot slip through).
//   · ENFORCEMENT: a plain 'serve' api key receives 403 on EVERY admin-
//     guarded /api route; the SAME probes with a 'serve+admin' key are never
//     authz-blocked. Serving itself stays untouched (sanity leg).
//   · FAIL CLOSED: malformed/unrecognized scopes values (inserted straight
//     into the column, past mint validation — the typo scenario) resolve to
//     serve-only; they can never mint an admin credential.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { sha256, type Policy } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { buildServer } from '../src/server.js';
import { ROUTE_INVENTORY } from '../src/security/route-inventory.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

const ORG = 'org_split';
const SERVE_KEY = 'pk_split_serve';
const ADMIN_KEY = 'pk_split_admin';
const POLICY: Policy = { type: 'min_cost', qualityFloor: 0 };

let app: FastifyInstance;
let tmpRoot: string;
const db = () => app.potion.db.db;

beforeAll(async () => {
  // The admin probes EXECUTE (a research scan among them) — point the price
  // registry at a throwaway copy so no probe can mutate the repo file
  // (research.test.ts precedent; without this the mock scan MERGES its
  // fixture models into prices.json and poisons later suites).
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'potion-split-'));
  const tmpPrices = path.join(tmpRoot, 'prices.json');
  copyFileSync(REPO_PRICES, tmpPrices);
  process.env.POTION_PRICES_PATH = tmpPrices;
  app = await buildServer({ seed: false });
  await createOrg(db(), { id: ORG, name: 'Split' });
  await insertPolicy(db(), { id: 'pol-split', orgId: ORG, name: 'split', config: POLICY });
  await insertApiKey(db(), {
    id: 'key-split-serve',
    keyHash: sha256(SERVE_KEY),
    name: 'serve',
    orgId: ORG,
    policyId: 'pol-split',
    // scopes omitted → the 'serve' DB default: the exact key every serving
    // customer holds.
  });
  await insertApiKey(db(), {
    id: 'key-split-admin',
    keyHash: sha256(ADMIN_KEY),
    name: 'admin',
    orgId: ORG,
    policyId: 'pol-split',
    scopes: 'serve+admin',
  });
}, 30000);

afterAll(async () => {
  delete process.env.POTION_PRICES_PATH;
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// completeness: fixture ⇔ live route tree
// ---------------------------------------------------------------------------

/** Parse fastify's printRoutes tree (radix segments CONCATENATE, no '/'
 * inserted — '/api/research/cycle' + 's' = '/api/research/cycles'). */
function routesFromTree(tree: string): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const raw of tree.split('\n')) {
    if (raw.trim() === '') continue;
    const m = /^((?:[│ ]   |[├└]── )*)(.*)$/.exec(raw);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    const rest = m[2]!;
    const methodsMatch = /^(.*?) \(([A-Z, ]+)\)$/.exec(rest);
    const segment = (methodsMatch ? methodsMatch[1]! : rest).trim();
    stack.length = Math.max(0, depth - 1);
    const full = stack.join('') + segment;
    stack.push(segment);
    if (methodsMatch) {
      for (const method of methodsMatch[2]!.split(',').map((s) => s.trim())) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        out.add(`${method} ${full}`);
      }
    }
  }
  return out;
}

describe('route inventory completeness (the anti-20th-site diff)', () => {
  it('every live route is classified; every classified route is live', () => {
    const live = routesFromTree(app.printRoutes({ commonPrefix: false }));
    const classified = new Set(ROUTE_INVENTORY.map((r) => `${r.method} ${r.path}`));
    const unclassified = [...live].filter((r) => !classified.has(r));
    const stale = [...classified].filter((r) => !live.has(r));
    expect(unclassified, `routes with NO inventory row (classify them in fixtures/route-inventory.ts): ${unclassified.join(', ')}`).toEqual([]);
    expect(stale, `inventory rows with no live route (stale fixture): ${stale.join(', ')}`).toEqual([]);
    // The fixture is exhaustive by construction, and non-trivially so.
    expect(ROUTE_INVENTORY.length).toBe(live.size);
    expect(ROUTE_INVENTORY.length).toBeGreaterThan(60);
  });
});

// ---------------------------------------------------------------------------
// enforcement: serve → 403 on EVERY admin-guarded route; serve+admin passes
// ---------------------------------------------------------------------------

const ADMIN_ROWS = ROUTE_INVENTORY.filter((r) => r.guard === 'admin' && r.surface === 'api');

function inject(key: string, row: (typeof ADMIN_ROWS)[number]) {
  return app.inject({
    method: row.method,
    url: row.probeUrl ?? row.path,
    headers: {
      authorization: `Bearer ${key}`,
      ...(row.probeBody !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(row.probeBody !== undefined ? { payload: row.probeBody } : {}),
  });
}

describe('serve keys lose EVERY admin mutation (exhaustive)', () => {
  it('has probes for every admin-guarded /api row', () => {
    // GET admin rows (audit) need no body; mutating ones need probe urls
    // with concrete params.
    for (const row of ADMIN_ROWS) {
      expect(row.probeUrl ?? row.path, `${row.method} ${row.path} needs a probeUrl without :params`).not.toContain(':');
    }
    expect(ADMIN_ROWS.length).toBeGreaterThanOrEqual(25);
  });

  for (const row of ADMIN_ROWS) {
    it(`403 for serve key, never 403 for serve+admin: ${row.method} ${row.path}`, async () => {
      const denied = await inject(SERVE_KEY, row);
      expect(denied.statusCode, `${row.method} ${row.path} must 403 a serve key, got ${denied.statusCode}: ${denied.body.slice(0, 200)}`).toBe(403);
      const code = denied.json()?.error?.code;
      expect(['insufficient_role', 'insufficient_scope']).toContain(code);
      const allowed = await inject(ADMIN_KEY, row);
      expect(allowed.statusCode, `${row.method} ${row.path} must not authz-block serve+admin, got 403: ${allowed.body.slice(0, 200)}`).not.toBe(403);
      expect(allowed.statusCode).not.toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// serve keys keep serving + member-grade self-service
// ---------------------------------------------------------------------------

describe('the serving surface is untouched (sanity leg)', () => {
  it('serve key: chat 200, trace ingest 202, /v1/policies self-rebind 201, reads 200, plain policy create 201', async () => {
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${SERVE_KEY}`, 'content-type': 'application/json' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'Write a function that reverses a string' }] },
    });
    expect(chat.statusCode).toBe(200);
    const ingest = await app.inject({
      method: 'POST',
      url: '/v1/traces',
      headers: { authorization: `Bearer ${SERVE_KEY}`, 'content-type': 'application/json' },
      payload: { spans: [{ trace_id: 't1', span_id: 's1', name: 'agent.root', attributes: {} }] },
    });
    expect(ingest.statusCode).toBe(202);
    const rebind = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${SERVE_KEY}`, 'content-type': 'application/json' },
      payload: { type: 'min_cost', qualityFloor: 0.5 },
    });
    expect(rebind.statusCode).toBe(201); // self-scoped onboarding mutation — deliberate
    const read = await app.inject({
      method: 'GET',
      url: '/api/guarantee/status',
      headers: { authorization: `Bearer ${SERVE_KEY}` },
    });
    expect(read.statusCode).toBe(200);
    // Member-grade self-service mutation stays open to serve keys.
    const plainPolicy = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { authorization: `Bearer ${SERVE_KEY}`, 'content-type': 'application/json' },
      payload: { policy: { type: 'min_cost', qualityFloor: 0 } },
    });
    expect(plainPolicy.statusCode).toBe(201);
  });

  it('key lifecycle inside /api/policies is ADMIN: serve key 403 on createKey and keyId; admin passes', async () => {
    for (const payload of [
      { policy: POLICY, createKey: true },
      { policy: POLICY, keyId: 'key-split-serve' },
    ]) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/policies',
        headers: { authorization: `Bearer ${SERVE_KEY}`, 'content-type': 'application/json' },
        payload,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('insufficient_role');
    }
    const minted = await app.inject({
      method: 'POST',
      url: '/api/policies',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      payload: { policy: POLICY, createKey: true },
    });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().apiKey).toMatch(/^pk_/);
  });
});

// ---------------------------------------------------------------------------
// fail closed: a typo in the scopes column never mints admin
// ---------------------------------------------------------------------------

describe('fail-closed scope resolution (the typo scenario)', () => {
  const PROBE = ADMIN_ROWS.find((r) => r.path === '/api/incidents/:id/resolve')!;

  it('malformed/unrecognized scopes → serve-only (403 on an admin probe); valid admin forms pass', async () => {
    const cases: Array<[string, number]> = [
      ['', 403],
      ['   ', 403],
      ['root', 403],
      ['serve+admin+root', 403], // 'admin' present but the value is invalid — STILL member
      ['admin;drop table', 403],
      ['Admin', 403], // case-sensitive vocabulary
      ['serve+admin', 404], // valid admin → passes the gate, then 404s the missing uuid
      ['admin', 404],
    ];
    for (let i = 0; i < cases.length; i++) {
      const [scopes, expected] = cases[i]!;
      const raw = `pk_split_fc_${i}`;
      await insertApiKey(db(), {
        id: `key-split-fc-${i}`,
        keyHash: sha256(raw),
        name: `fc-${i}`,
        orgId: ORG,
        scopes, // straight into the column — past mint validation, the typo path
      });
      const res = await inject(raw, PROBE);
      expect(res.statusCode, `scopes '${scopes}' → expected ${expected}, got ${res.statusCode}`).toBe(expected);
    }
  });

  it('mint-time vocabulary is closed: unknown tokens 400', async () => {
    for (const scopes of ['root', 'serve+root', 'admin']) {
      // 'admin' alone lacks the required 'serve' token at MINT time (a key
      // that cannot serve is a mistake); resolution still honors it if it
      // reaches the column another way (fail-closed test above).
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-keys',
        headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
        payload: { name: 'bad-scopes', scopes },
      });
      expect(res.statusCode, `mint with scopes '${scopes}' must 400`).toBe(400);
    }
  });
});
