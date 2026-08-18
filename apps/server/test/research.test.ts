// Research + leaderboard route tests (M4b, ROADMAP #37/#32, SPEC §15.5/§13.4).
//   · POST /api/research/scan: admin 202 + validation; mock scan extends a
//     TMP prices.json (never the repo file — POTION_PRICES_PATH) and fans out
//     research:cycle jobs whose ledger rows land in research_cycles
//   · GET /api/recipes: the library — candidate recipes with mock provenance
//     after the scan cycles; ?status filter; viewer may read
//   · POST /api/recipes/:hash/evaluate: 404 unknown hash; 202 → single-
//     candidate cycle (recipeHash narrowing); admin gate (viewer 403)
//   · GET /api/leaderboard: PUBLIC without any session (dev bypass OFF →
//     still 200); honest 'awaiting_live_verification' pre-live; seeded LIVE
//     evidence → status ok with verificationRunId; org opt-in adopter names
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type StrategyConfig } from '@potion/core';
import { loadModelRegistry,
  createMembership,
  createSession,
  createUser,
  evalResults,
  clusters,
  orgs,
  strategyConfigs,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { eq } from 'drizzle-orm';
import { buildServer } from '../src/server.js';
// G2.4 carryover: two distinct NON-DEFAULT orgs — the demo org is never the
// probed subject (see the fixture header; that assumption hid defect D1).
import { ORG_A, ORG_A_NAME, ORG_B, seedIsolationOrgs } from './fixtures/orgs.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let app: FastifyInstance;
let root: string;
let tmpPrices: string;
const db = () => app.potion.db.db;

/** Poll a job to a terminal state (the in-process worker runs real handlers). */
async function waitJob(jobId: string, timeoutMs = 120_000): Promise<{ state: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: string; error?: string };
    if (body.state === 'completed' || body.state === 'failed') return body;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-server-research-'));
  tmpPrices = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, tmpPrices);
  // The research:scan worker WRITES the registry on new-model detection —
  // point it at the tmp copy so tests never touch the repo prices.json.
  process.env.POTION_PRICES_PATH = tmpPrices;
  app = await buildServer({ seed: false, pricesPath: tmpPrices });
  await seedIsolationOrgs(db());

  // Cluster row for the leaderboard iteration (seed:false → empty taxonomy).
  await db().insert(clusters).values({ id: 'code-gen', name: 'Code generation', description: 'js' });

  // Viewer session for the role gates.
  await createUser(db(), { id: 'usr_r_viewer', email: 'viewer@r.dev', name: 'viewer' });
  await createMembership(db(), { orgId: ORG_A, userId: 'usr_r_viewer', role: 'viewer' });
  await createSession(db(), {
    id: 'ses_r_viewer',
    userId: 'usr_r_viewer',
    tokenHash: sha256('ps_r_viewer'),
    orgId: ORG_A,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  await app.close();
  delete process.env.POTION_PRICES_PATH;
  rmSync(root, { recursive: true, force: true });
});

const VIEWER = { cookie: 'potion_session=ps_r_viewer' };

describe('POST /api/research/scan', () => {
  it('rejects a bad source (400) and non-admin roles (403)', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/research/scan',
      payload: { source: 'anthropic' },
    });
    expect(bad.statusCode).toBe(400);

    const viewer = await app.inject({
      method: 'POST',
      url: '/api/research/scan',
      payload: { source: 'mock' },
      headers: VIEWER,
    });
    expect(viewer.statusCode).toBe(403);
  });

  it('202 → mock scan extends the registry and cycles complete (ledger rows)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/research/scan',
      payload: { source: 'mock' },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const job = await waitJob(jobId);
    expect(job.error).toBeUndefined();

    // The registry gained the two fixture models.
    //
    // S5: the registry is the DATABASE now. This used to read the tmp
    // prices.json, because a scan wrote there — which is exactly the bug S5
    // removed: a file inside the container image loses every discovery on
    // redeploy and never reaches the running process regardless. Same claim,
    // read from where the catalog actually lives.
    const merged = (await loadModelRegistry(app.potion.db.db))!;
    expect(merged.entries.map((e) => e.alias)).toContain('or-mock-nova-1');
    expect(merged.entries.map((e) => e.alias)).toContain('or-mock-apex-1');
    // …and the FILE is untouched, which is the property that makes the
    // catalog survive a deploy.
    const onDisk = JSON.parse(readFileSync(tmpPrices, 'utf8')) as { entries: { alias: string }[] };
    expect(onDisk.entries.map((e) => e.alias)).not.toContain('or-mock-nova-1');

    // The scan fanned out research:cycle jobs; their ledger rows complete.
    const deadline = Date.now() + 120_000;
    let cycles: { id: string; status: string; trigger: string; provenance: string }[] = [];
    for (;;) {
      const res2 = await app.inject({ method: 'GET', url: '/api/research/cycles' });
      expect(res2.statusCode).toBe(200);
      cycles = (res2.json() as { cycles: typeof cycles }).cycles;
      if (cycles.length >= 1 && cycles.every((c) => c.status === 'completed' || c.status === 'failed')) break;
      if (Date.now() > deadline) throw new Error('research cycles did not settle');
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(cycles[0]!.trigger).toBe('scan');
    expect(cycles[0]!.provenance).toBe('mock');
    expect(cycles[0]!.status).toBe('completed');

    // The recipe library now shows candidate recipes with SIMULATED
    // provenance — mock cycles shortlist, never promote.
    const recipesRes = await app.inject({ method: 'GET', url: '/api/recipes?status=candidate' });
    expect(recipesRes.statusCode).toBe(200);
    const { recipes } = recipesRes.json() as {
      recipes: { hash: string; status: string; provenance: string; lineage: { evalCount: number; cycles: unknown[] } }[];
    };
    expect(recipes.length).toBeGreaterThan(0);
    for (const r of recipes) {
      expect(r.status).toBe('candidate');
      expect(['mock', 'unknown']).toContain(r.provenance);
    }
    const evaluated = recipes.filter((r) => r.lineage.evalCount > 0);
    expect(evaluated.length).toBeGreaterThan(0);
    expect(evaluated[0]!.lineage.cycles.length).toBeGreaterThan(0);
  }, 180_000);
});

describe('GET /api/leaderboard (PUBLIC)', () => {
  it('is session-free and honest before any live evidence exists', async () => {
    // Dev bypass OFF: without the §13.4 exemption this would be a 401.
    process.env.POTION_DEV_AUTH = '0';
    try {
      const res = await app.inject({ method: 'GET', url: '/api/leaderboard' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; entries: unknown[] };
      expect(body.status).toBe('awaiting_live_verification');
      expect(body.entries).toEqual([]);

      // …while guarded siblings still demand auth under the same env.
      const guarded = await app.inject({ method: 'GET', url: '/api/recipes' });
      expect(guarded.statusCode).toBe(401);
    } finally {
      delete process.env.POTION_DEV_AUTH;
    }
  });
});

describe('POST /api/recipes/:hash/evaluate', () => {
  it('404 for unknown hash; 403 for viewer; 202 runs a one-candidate cycle', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/recipes/sha-nope/evaluate' });
    expect(missing.statusCode).toBe(404);

    const config: StrategyConfig = { type: 'single', model: 'mock-cheap' };
    const hash = strategyHash(config);
    await db().insert(strategyConfigs).values({ hash, config }).onConflictDoNothing();

    const viewer = await app.inject({
      method: 'POST',
      url: `/api/recipes/${hash}/evaluate`,
      headers: VIEWER,
    });
    expect(viewer.statusCode).toBe(403);

    const res = await app.inject({ method: 'POST', url: `/api/recipes/${hash}/evaluate` });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    const job = await waitJob(jobId, 120_000);
    expect(job.error).toBeUndefined();

    // The recipe's lineage now carries the manual evaluation cycle.
    const recipesRes = await app.inject({ method: 'GET', url: '/api/recipes' });
    const { recipes } = recipesRes.json() as {
      recipes: { hash: string; lineage: { evalCount: number; cycles: { trigger: string }[] } }[];
    };
    const recipe = recipes.find((r) => r.hash === hash);
    expect(recipe).toBeDefined();
    expect(recipe!.lineage.evalCount).toBeGreaterThan(0);
    expect(recipe!.lineage.cycles.some((c) => c.trigger === 'manual')).toBe(true);
  }, 180_000);
});

describe('GET /api/leaderboard with live evidence (§13.4)', () => {
  it('lists live-provenance points with verification run ids + adopter names', async () => {
    const config: StrategyConfig = { type: 'single', model: 'mock-frontier' };
    const hash = strategyHash(config);
    const version = app.potion.prices.version;

    // Seed live-provenance eval rows (as an M1b-style live sweep would).
    for (let i = 1; i <= 3; i++) {
      await db().insert(evalResults).values({
        cacheKey: `lb-live-${i}`,
        runId: 'live-run-lb',
        itemId: `he-js-js-bench-0${i}`,
        clusterId: 'code-gen',
        strategyHash: hash,
        strategyConfig: config,
        quality: 0.9,
        scorer: 'exact',
        usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001, latencyMs: 5 },
        latencyMs: { p50: 5, p95: 5, mean: 5 },
        modelVersions: {},
        pricesVersion: version,
        providerMode: 'live',
        createdAt: new Date().toISOString(),
      });
    }
    await saveFrontier(
      db(),
      'code-gen',
      [
        {
          clusterId: 'code-gen',
          strategyHash: hash,
          strategyConfig: config,
          quality: 0.9,
          costPer1K: 1,
          latencyP95: 5,
          providerMode: 'live',
        },
      ],
      'manual',
      version,
    );

    // Org opts into public publishing (names only).
    await db().update(orgs).set({ publishToLeaderboard: true }).where(eq(orgs.id, ORG_A));

    const res = await app.inject({ method: 'GET', url: '/api/leaderboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      entries: {
        clusterId: string;
        strategyHash: string;
        strategyLabel: string;
        quality: number;
        verificationRunId: string | null;
      }[];
      adoptingOrgs: string[];
    };
    expect(body.status).toBe('ok');
    const entry = body.entries.find((e) => e.clusterId === 'code-gen');
    expect(entry).toBeDefined();
    expect(entry!.strategyHash).toBe(hash);
    expect(entry!.strategyLabel).toBe('single · mock-frontier');
    expect(entry!.verificationRunId).toBe('live-run-lb');
    expect(body.adoptingOrgs).toContain(ORG_A_NAME);
  });
});

// ---------------------------------------------------------------------------
// G1.8 — per-org cycle trigger + scoped surfaces
// ---------------------------------------------------------------------------

describe('G1.8 per-org research surfaces', () => {
  it('POST /api/research/cycle: viewer 403; cross-org/unknown suite 404; owned 202 with forced org', async () => {
    const d = db();
    const { insertResearchCycle } = await import('@potion/db');
    // admin session on the subject org
    await createUser(d, { id: 'usr_rc_admin', email: 'rcadmin@r.dev', name: 'a' });
    await createMembership(d, { orgId: ORG_A, userId: 'usr_rc_admin', role: 'admin' });
    await createSession(d, {
      id: 'ses_rc_admin',
      userId: 'usr_rc_admin',
      tokenHash: sha256('ps_rc_admin'),
      orgId: ORG_A,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const ADMIN = { cookie: 'potion_session=ps_rc_admin' };

    // viewer refused
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/research/cycle',
      headers: { ...VIEWER, 'content-type': 'application/json' },
      payload: { clusterId: 'agent-abcdef-123456' },
    });
    expect(forbidden.statusCode).toBe(403);

    // unknown agent cluster → 404 (no oracle); another org's → same 404
    await d.insert(clusters).values({
      id: 'agent-ffffff-eeeeee',
      name: 'agent: x',
      description: 'x',
      orgId: ORG_B,
    });
    for (const clusterId of ['agent-nosuch-cluster', 'agent-ffffff-eeeeee']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/research/cycle',
        headers: { ...ADMIN, 'content-type': 'application/json' },
        payload: { clusterId },
      });
      expect(res.statusCode).toBe(404);
    }

    // owned agent cluster → 202
    await d.insert(clusters).values({
      id: 'agent-dddddd-cccccc',
      name: 'agent: owned',
      description: 'o',
      orgId: ORG_A,
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/research/cycle',
      headers: { ...ADMIN, 'content-type': 'application/json' },
      payload: { clusterId: 'agent-dddddd-cccccc', capUsd: 2 },
    });
    expect(ok.statusCode).toBe(202);
    expect((ok.json() as { jobId: string }).jobId).toBeTruthy();

    // cycles listing hides other orgs' cycles, shows platform + own
    await insertResearchCycle(d, { trigger: 'manual', candidates: [], status: 'completed', seed: 1 });
    await insertResearchCycle(d, { trigger: 'manual', candidates: [], status: 'completed', seed: 2, orgId: ORG_A });
    await insertResearchCycle(d, { trigger: 'manual', candidates: [], status: 'completed', seed: 3, orgId: ORG_B });
    const list = await app.inject({ method: 'GET', url: '/api/research/cycles', headers: VIEWER });
    expect(list.statusCode).toBe(200);
    const { cycles } = list.json() as { cycles: Array<{ orgId: string | null }> };
    expect(cycles.some((c) => c.orgId === ORG_B)).toBe(false);
    expect(cycles.some((c) => c.orgId === ORG_A)).toBe(true);
    expect(cycles.some((c) => c.orgId === null)).toBe(true);
  });

  it('GET /api/recipes lineage no longer lists foreign agent clusters', async () => {
    const d = db();
    const { insertEvalResult } = await import('@potion/db');
    const mk = (cacheKey: string, clusterId: string, orgId?: string) => ({
      runId: 'run-lineage',
      itemId: cacheKey,
      clusterId,
      strategyHash: 'h-lineage',
      strategyConfig: { type: 'single' as const, model: 'mock-mid' },
      quality: 0.5,
      scorer: 'exact',
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 },
      latencyMs: { p50: 1, p95: 1, mean: 1 },
      modelVersions: {},
      pricesVersion: 'lineage-pv',
      cacheKey,
      createdAt: new Date().toISOString(),
      ...(orgId !== undefined ? { orgId } : {}),
    });
    // lineage attaches only to REGISTERED hashes — register ours first
    const { strategyConfigs: scTable } = await import('@potion/db');
    await d
      .insert(scTable)
      .values({ hash: 'h-lineage', config: { type: 'single', model: 'mock-mid' } })
      .onConflictDoNothing();
    await insertEvalResult(d, mk('lin-platform', 'code-gen'));
    await insertEvalResult(d, mk('lin-own', 'agent-dddddd-cccccc', ORG_A));
    await insertEvalResult(d, mk('lin-foreign', 'agent-ffffff-eeeeee', ORG_B));
    const res = await app.inject({ method: 'GET', url: '/api/recipes', headers: VIEWER });
    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw).toContain('agent-dddddd-cccccc');
    expect(raw).not.toContain('agent-ffffff-eeeeee'); // foreign tenant invisible
  });
});
