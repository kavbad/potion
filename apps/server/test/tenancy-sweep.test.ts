// G2.4 THE TENANCY SWEEP — the lens PROBES, it does not merely classify.
//
// For every org-scoped route in the shared inventory, ORG_B acts against
// ORG_A's REAL resources and the response must be indistinguishable from
// one naming a resource that never existed: same status AND same body
// shape. That uniformity is what turns the no-existence-oracle convention
// (G1.2, G1.6) into a PROPERTY instead of a habit — a 403 or a differently
// shaped 404 is itself an existence oracle.
//
// Two design decisions carry the sweep:
//   1. ORG_A is NOT DEFAULT_ORG_ID. Every pre-G2.4 isolation test set
//      ORG_A = org_demo, which is exactly what hid D1 (a bearer-only
//      resolver falling back to the demo org looks correct when the org
//      under test IS the demo org). Asserted below.
//   2. Probes run under BOTH credential kinds (bearer api key and session
//      cookie) — D1 was a cookie-path defect invisible to bearer probes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  clusters,
  createMembership,
  createOrg,
  createSession,
  createUser,
  insertAlertRule,
  insertApiKey,
  insertClusterRubric,
  insertSuiteCertificationTx,
  insertIncidentRow,
  insertPolicy,
  insertProviderKey,
  insertShareToken,
  insertTraceSpans,
  createLabRun,
  upsertLabGrant,
  upsertDerivedSuite,
  upsertLabHarness,
  upsertStrategyConfig,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import { ROUTE_INVENTORY, type RouteInventoryRow } from '../src/security/route-inventory.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

const ORG_A = 'org_sweep_a'; // NOT org_demo — see header
const ORG_B = 'org_sweep_b';
const KEY_A = 'pk_sweep_a';
const KEY_B = 'pk_sweep_b';
const COOKIE_B = 'potion_session=ps_sweep_b';
const POLICY: Policy = { type: 'min_cost', qualityFloor: 0 };
const CFG: StrategyConfig = { type: 'single', model: 'mock-mid' };

/** ORG_A's real resource ids, filled in beforeAll. */
const seeded: Record<string, string> = {};
/** Syntactically-valid ids that never existed (the control arm). */
const UNKNOWN: Record<string, string> = {
  providerKey: 'pk-row-does-not-exist',
  apiKey: 'key-does-not-exist',
  job: 'mem-999999',
  cluster: 'agent-000000-nothing',
  trace: 'tr_does_not_exist',
  incident: '00000000-0000-4000-8000-00000000dead',
  rubric: '00000000-0000-4000-8000-00000000beef',
  shareToken: 'st_does_not_exist',
  alertRule: '00000000-0000-4000-8000-000000000404',
  labHarness: 'f'.repeat(64),
  labRun: 'run-neverexist',
  labGrant: 'grant-neverexist',
};

let app: FastifyInstance;
let tmpRoot: string;
let devAuthBefore: string | undefined;
const db = () => app.potion.db.db;

function point(quality: number): FrontierPoint {
  return {
    clusterId: seeded.cluster!,
    strategyHash: strategyHash(CFG),
    strategyConfig: CFG,
    quality,
    costPer1K: 1,
    latencyP95: 100,
  };
}

/** Sorted key skeleton — two responses share a shape when their JSON has the
 * same key structure, regardless of values. A foreign id must be
 * indistinguishable from an unknown one at THIS granularity. */
function shapeOf(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `nonjson:${raw.length === 0 ? 'empty' : 'text'}`;
  }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return ['array'];
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .map((k) => `${k}:${JSON.stringify(walk(o[k]))}`);
    }
    return typeof v;
  };
  return JSON.stringify(walk(parsed));
}

beforeAll(async () => {
  devAuthBefore = process.env.POTION_DEV_AUTH;
  process.env.POTION_DEV_AUTH = '0'; // credentials are the only way in
  // Probes EXECUTE handlers (research scan, rubric generate…): keep every
  // file-backed dependency on a throwaway copy (G2.3 lesson).
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'potion-sweep-'));
  const tmpPrices = path.join(tmpRoot, 'prices.json');
  copyFileSync(REPO_PRICES, tmpPrices);
  process.env.POTION_PRICES_PATH = tmpPrices;

  app = await buildServer({ seed: false });

  for (const [org, raw, user, token] of [
    [ORG_A, KEY_A, 'usr_sweep_a', 'ps_sweep_a'],
    [ORG_B, KEY_B, 'usr_sweep_b', 'ps_sweep_b'],
  ] as const) {
    await createOrg(db(), { id: org, name: org });
    await insertPolicy(db(), { id: `pol-${org}`, orgId: org, name: 'p', config: POLICY });
    await insertApiKey(db(), {
      id: `key-${org}`,
      keyHash: sha256(raw),
      name: 'k',
      orgId: org,
      policyId: `pol-${org}`,
      scopes: 'serve+admin', // admin probes must reach the TENANCY check, not 403 on role
    });
    await createUser(db(), { id: user, email: `${user}@sweep.dev`, name: user });
    await createMembership(db(), { orgId: org, userId: user, role: 'admin' });
    await createSession(db(), {
      id: `ses-${org}`,
      userId: user,
      tokenHash: sha256(token),
      orgId: org,
      expiresAt: new Date(Date.now() + 3600_000),
    });
  }

  // ---- one of each org-owned resource, in ORG_A ----
  seeded.apiKey = `key-${ORG_A}`; // NOTE: contains the org id by construction
  const pk = await insertProviderKey(db(), {
    id: 'pk-sweep-a',
    orgId: ORG_A,
    name: 'sweep-a-key',
    provider: 'openai',
    keyCiphertext: Buffer.from('ct'),
    keyIv: Buffer.from('iv'),
    keyTag: Buffer.from('tag'),
    dataKeyCiphertext: Buffer.from('dk'),
    dataKeyIv: Buffer.from('dkiv'),
    dataKeyTag: Buffer.from('dktag'),
    maskedKey: 'sk-…aaaa',
    keyHash: sha256('sweep-a-provider-key'),
  });
  seeded.providerKey = pk?.id ?? 'pk-sweep-a';

  seeded.cluster = 'agent-sweepa-billing';
  await db()
    .insert(clusters)
    .values({ id: seeded.cluster, name: 'billing', description: 'sweep A cluster', orgId: ORG_A });
  await upsertStrategyConfig(db(), strategyHash(CFG), CFG);
  await saveFrontier(db(), seeded.cluster, [point(0.9)], 'manual', '2026-08-04', { orgId: ORG_A });
  await upsertDerivedSuite(db(), {
    suiteId: `${seeded.cluster}-replays-v1`,
    clusterId: seeded.cluster,
    orgId: ORG_A,
    manifest: {},
    items: [],
    itemCap: 25,
  });

  seeded.trace = 'tr_sweep_a';
  await insertTraceSpans(db(), [
    {
      orgId: ORG_A,
      traceId: seeded.trace,
      spanId: 'sp1',
      name: 'agent.root',
      model: 'mock-cheap',
      usage: { input_tokens: 5, output_tokens: 5 },
      costUsd: 0,
      attrs: {},
      ts: new Date(),
    },
  ]);

  const incident = await insertIncidentRow(db(), {
    orgId: ORG_A,
    kind: 'quality_breach',
    detail: { clusterId: seeded.cluster, fromStrategy: strategyHash(CFG) },
  });
  seeded.incident = incident.id;

  seeded.rubric = await insertClusterRubric(db(), {
    orgId: ORG_A,
    clusterId: seeded.cluster,
    suiteId: `${seeded.cluster}-replays-v1`,
    rubricText: 'sweep A rubric',
    rubricHash: 'hash-sweep-a',
    generatorModel: 'mock-cheap',
    providerMode: 'mock',
    exemplarCount: 3,
  });

  // A certification ROW for the list-leak arm only (a refused 'failed' row —
  // tenancy fixture, not a certification claim; nothing consumes it as one).
  seeded.certification = await insertSuiteCertificationTx(db(), {
    orgId: ORG_A,
    clusterId: seeded.cluster,
    suiteId: `${seeded.cluster}-replays-v1`,
    suiteVersion: '1.0.0',
    providerMode: 'mock',
    status: 'failed',
    statusReason: 'refused-no-incumbent: sweep fixture',
    evidence: { refused: true, kind: 'no-incumbent' },
  });

  const share = await insertShareToken(db(), {
    orgId: ORG_A,
    kind: 'frontier',
    payload: { clusterId: 'code-gen' },
    tokenHash: sha256('st_sweep_a_raw'),
    redactNames: true,
  });
  seeded.shareToken = share.id;

  const rule = await insertAlertRule(db(), {
    orgId: ORG_A,
    kind: 'webhook',
    targetUrl: 'https://sweep-a.example/hook',
    events: ['quality_breach'] as never,
  });
  seeded.alertRule = rule.id;

  // Lab Step 8: a catalog harness + a trial run in ORG_A (the /api/lab rows).
  seeded.labHarness = 'ab'.repeat(32);
  const labSpec = {
    specVersion: 1, name: 'sweep harness', brain: { policy: POLICY },
    mission: { kind: 'task', goal: 'sweep the tenancy', doneDefinition: 'swept' },
    superpowers: [], memory: { enabled: false }, rules: [],
    fuel: { maxUsdPerRun: 1, hardStop: true }, checkIns: [],
  };
  await upsertLabHarness(db(), {
    orgId: ORG_A,
    harnessHash: seeded.labHarness,
    name: 'sweep harness',
    specText: JSON.stringify(labSpec),
    sidecar: { specHash: seeded.labHarness, choicesHash: 'x', choices: [] },
    clusterId: 'code-gen',
  });
  seeded.labRun = 'run-sweepa1';
  await createLabRun(db(), {
    id: seeded.labRun,
    orgId: ORG_A,
    harnessHash: seeded.labHarness,
    harnessName: 'sweep harness',
    spec: labSpec,
  });

  // Lab Step 10: a superpower grant in ORG_A (the /api/lab/connectors
  // org-list arm — its id must never surface in ORG_B's response).
  seeded.labGrant = 'grant-sweepa1';
  await upsertLabGrant(db(), {
    id: seeded.labGrant,
    orgId: ORG_A,
    connectorId: 'github',
    superpowerId: 'github',
    scopesGranted: ['read'],
    tokenEnvelope: 'v1.c3dlZXAtZml4dHVyZS1lbnZlbG9wZQ',
    grantedBy: 'usr_sweep_a',
  });

  // A job OWNED by ORG_A (the org-scoped arm of the platform-job row).
  seeded.job = await app.potion.queue!.enqueue('guarantee:evaluate', { orgId: ORG_A });
  // A PLATFORM job — no orgId in the payload (the D2 arm).
  seeded.platformJob = await app.potion.queue!.enqueue('guarantee:evaluate', {});
}, 60000);

afterAll(async () => {
  if (devAuthBefore === undefined) delete process.env.POTION_DEV_AUTH;
  else process.env.POTION_DEV_AUTH = devAuthBefore;
  delete process.env.POTION_PRICES_PATH;
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// the sweep design itself is asserted first
// ---------------------------------------------------------------------------

describe('sweep design invariants', () => {
  it('ORG_A is not the demo org (the assumption that hid D1)', () => {
    expect(ORG_A).not.toBe(DEFAULT_ORG_ID);
    expect(ORG_B).not.toBe(DEFAULT_ORG_ID);
  });

  it('every /api and /v1 row carries a tenancy class and a cross-org verdict', () => {
    const unclassified = ROUTE_INVENTORY.filter(
      (r) => (r.surface === 'api' || r.surface === 'v1') && (!r.tenancyClass || !r.crossOrgProbe),
    ).map((r) => `${r.method} ${r.path}`);
    expect(unclassified, `rows missing the G2.4 tenancy lens: ${unclassified.join(', ')}`).toEqual([]);
    // Whole-inventory coverage (auth/operator/infra included).
    expect(ROUTE_INVENTORY.every((r) => r.tenancyClass !== undefined)).toBe(true);
  });

  it('every skip is JUSTIFIED and every org-param row names a seeded resource', () => {
    for (const r of ROUTE_INVENTORY) {
      if (r.crossOrgProbe?.expect === 'skip') {
        expect(
          r.crossOrgProbe.skipReason && r.crossOrgProbe.skipReason.length > 10,
          `${r.method} ${r.path} skips without a reason`,
        ).toBeTruthy();
      }
      if (r.tenancyClass === 'org-param' && r.crossOrgProbe?.expect === 'uniform-404') {
        expect(r.seededResource, `${r.method} ${r.path} probes no seeded resource`).toBeTruthy();
        expect(r.seededResource).not.toBe('none');
      }
    }
  });

  it('probes exist in meaningful numbers (a vacuous sweep is a failed sweep)', () => {
    const probed = ROUTE_INVENTORY.filter((r) => r.crossOrgProbe?.expect === 'uniform-404');
    const lists = ROUTE_INVENTORY.filter((r) => r.crossOrgProbe?.expect === 'org-list-absent');
    expect(probed.length).toBeGreaterThanOrEqual(15);
    expect(lists.length).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// the uniform no-existence-oracle probe
// ---------------------------------------------------------------------------

const ORG_PARAM_ROWS = ROUTE_INVENTORY.filter(
  (r) => r.crossOrgProbe?.expect === 'uniform-404' && r.seededResource,
);

function urlFor(row: RouteInventoryRow, id: string): string {
  const param = row.resourceParam ?? ':id';
  return row.path.replace(param, id);
}

function inject(row: RouteInventoryRow, url: string, creds: Record<string, string>, id?: string) {
  // Body-carried resource ids (resourceBodyField) are SUBSTITUTED per probe
  // arm — without this, routes whose id travels in the body get three
  // byte-identical requests and the uniform-404 comparison is vacuous
  // (Step 8 review finding).
  const payload =
    row.probeBody !== undefined
      ? row.resourceBodyField !== undefined && id !== undefined
        ? { ...row.probeBody, [row.resourceBodyField]: id }
        : row.probeBody
      : undefined;
  return app.inject({
    method: row.method,
    url,
    headers: { ...creds, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

describe('cross-org probes: ORG_A’s real id is indistinguishable from a nonexistent one', () => {
  for (const row of ORG_PARAM_ROWS) {
    for (const [credName, creds] of [
      ['bearer', { authorization: `Bearer ${KEY_B}` }],
      ['cookie', { cookie: COOKIE_B }],
    ] as const) {
      it(`${row.method} ${row.path} (${credName})`, async () => {
        const kind = row.seededResource!;
        const foreignId = kind === 'job' ? seeded.job! : seeded[kind]!;
        const unknownId = UNKNOWN[kind]!;
        const foreign = await inject(row, urlFor(row, foreignId), creds, foreignId);
        const unknown = await inject(row, urlFor(row, unknownId), creds, unknownId);
        // Third arm: a MALFORMED id must be REFUSED, not crash. 400 (input
        // validation, uniform for every caller) and 404 (indistinguishable
        // from not-found) are both honest; a 5xx is not — it means the param
        // reached the db, and it returns a raw SQL error in the body while
        // making "malformed" distinguishable from "not yours".
        const malformed = await inject(row, urlFor(row, 'not-an-id-%21'), creds, 'not-an-id-%21');
        expect(
          malformed.statusCode,
          `${row.method} ${row.path}: a malformed id returned ${malformed.statusCode} — ` +
            `it must be refused (400/404), never crash (body: ${malformed.body.slice(0, 160)})`,
        ).toBeLessThan(500);
        expect(malformed.body).not.toMatch(/Failed query|select |update |insert /i);
        expect(
          foreign.statusCode,
          `${row.method} ${row.path}: ORG_A's real id returned ${foreign.statusCode} to ORG_B ` +
            `(unknown id returns ${unknown.statusCode}) — that difference IS the oracle`,
        ).toBe(unknown.statusCode);
        expect(foreign.statusCode).toBe(404);
        expect(
          shapeOf(foreign.body),
          `${row.method} ${row.path}: foreign-id body shape differs from unknown-id`,
        ).toBe(shapeOf(unknown.body));
        // And nothing of ORG_A leaks into the refusal — except where the
        // caller-supplied id itself embeds it (echoing the caller's own
        // input reveals nothing it did not already have).
        if (!foreignId.includes(ORG_A)) {
          expect(foreign.body).not.toContain(ORG_A);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// list routes: ORG_A's rows never appear for ORG_B
// ---------------------------------------------------------------------------

const LIST_ROWS = ROUTE_INVENTORY.filter((r) => r.crossOrgProbe?.expect === 'org-list-absent');

describe('org-scoped lists never carry another tenant’s rows', () => {
  for (const row of LIST_ROWS) {
    it(`${row.method} ${row.path}`, async () => {
      const res = await inject(row, row.probeUrl ?? row.path, { cookie: COOKIE_B });
      // Reads may 200 or 400 (missing required query) — never another org's data.
      expect([200, 400]).toContain(res.statusCode);
      const body = res.body;
      expect(body, `${row.path} leaked ORG_A's id`).not.toContain(ORG_A);
      for (const [kind, id] of Object.entries(seeded)) {
        if (kind === 'job' || kind === 'platformJob') continue; // ids are opaque counters
        expect(body, `${row.path} leaked ORG_A's ${kind} id`).not.toContain(id);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// platform jobs (D2): owned by no org → invisible to every tenant
// ---------------------------------------------------------------------------

describe('platform jobs are invisible to tenants (D2)', () => {
  it('a payload without an orgId 404s for BOTH orgs and both credential kinds', async () => {
    for (const creds of [
      { authorization: `Bearer ${KEY_A}` },
      { authorization: `Bearer ${KEY_B}` },
      { cookie: COOKIE_B },
    ]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/jobs/${seeded.platformJob}`,
        headers: creds,
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('the owning org still reads its OWN job (scoping, not suppression)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/jobs/${seeded.job}`,
      headers: { authorization: `Bearer ${KEY_A}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
