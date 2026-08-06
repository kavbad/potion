// Chaos: instance kill during shadow (ROADMAP #29, SPEC §12.9).
//
// The shadow candidate's provider is DEAD (chaosProvider failRate=1 — every
// candidate execution throws). TRUE BEHAVIOR (documented, tested here):
//   · The PRIMARY response completes within SLO — the shadow run is
//     fire-and-forget AFTER the response (routes/chat.ts `void runShadow`),
//     so a dead/hanging candidate provider can never add primary latency.
//   · The shadow failure is SWALLOWED: pino warn + the shadow metric only —
//     no shadow_results row for the dead candidate, no 5xx, the server stays
//     healthy (/healthz + a subsequent request both fine).
//   · A HANGING candidate (failRate=0 + hangMs) is equally contained: the
//     response returns far inside the hang window.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256, strategyHash, type FrontierPoint, type StrategyConfig } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy, listShadowResults, utcDay } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import {
  chaosProvider,
  createMockProvider,
  loadPrices,
  type Provider,
} from '@potion/providers';
import { buildServer } from '@potion/server/server';
import { DEFAULT_PRICES_PATH } from '@potion/server/context';

const ORG_A = DEFAULT_ORG_ID;
const CODE_PROMPT = 'Write a python function that reverses a string';

/** Fastify instance type without a direct fastify dependency. */
type App = Awaited<ReturnType<typeof buildServer>>;

// Primary: 'gpt-mini-class' → provider 'openai' (fast mock). Candidate:
// 'mock-cheap' → provider 'mock' (the chaos/dead instance).
const PRIMARY_CFG = { type: 'single', model: 'gpt-mini-class' } as const;
const CANDIDATE_CFG = { type: 'single', model: 'mock-cheap' } as const;

function point(config: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
  return {
    clusterId: 'code-gen',
    strategyHash: strategyHash(config),
    strategyConfig: config,
    quality,
    costPer1K,
    latencyP95: 500,
  };
}

async function buildShadowApp(deadProvider: Provider): Promise<App> {
  const { table: prices } = loadPrices(DEFAULT_PRICES_PATH);
  const fast: Provider = createMockProvider(prices);
  const dead: Provider = {
    ...deadProvider,
    ...(fast.embed ? { embed: fast.embed.bind(fast) } : {}), // boot embedder works
  };
  const app = await buildServer({
    seed: false,
    providers: { anthropic: fast, openai: fast, google: fast, openrouter: fast, mock: dead },
  });
  const db = app.potion.db.db;
  // max_quality ceiling 2 → only the fast point is feasible as primary; the
  // cheap point rides the frontier as the shadow candidate.
  await saveFrontier(db, 'code-gen', [point(PRIMARY_CFG, 0.9, 1.0), point(CANDIDATE_CFG, 0.5, 0.1)], 'manual', '2026-08-05');
  await insertPolicy(db, {
    id: 'pol-chaos-shadow',
    orgId: ORG_A,
    name: 'pol-chaos-shadow',
    config: {
      type: 'max_quality',
      costCeilingPer1K: 2,
      shadow: { sampleRate: 1, candidates: 'frontier' },
    },
  });
  await insertApiKey(db, {
    id: 'key-chaos-shadow',
    keyHash: sha256('pk_chaos_shadow'),
    name: 'chaos-shadow',
    orgId: ORG_A,
    policyId: 'pol-chaos-shadow',
  });
  return app;
}

async function chat(app: App) {
  const t0 = Date.now();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer pk_chaos_shadow', 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }] },
  });
  return { res, elapsedMs: Date.now() - t0 };
}

describe('chaos: instance kill during shadow', () => {
  describe('dead candidate provider (failRate=1 — every shadow call throws)', () => {
    let app: App;
    beforeAll(async () => {
      app = await buildShadowApp(chaosProvider({ failRate: 1, seed: 42 }));
    }, 90_000);
    afterAll(async () => {
      await app.close();
    });

    it('primary completes within SLO; shadow failure swallowed; server stays healthy', async () => {
      const t0 = Date.now();
      const { res, elapsedMs } = await chat(app);
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-frontier-trace']).toContain(`strategy=${strategyHash(PRIMARY_CFG).slice(0, 8)}`);
      expect(res.json().choices[0].message.content).toBeTruthy();
      // SLO: mock-world primary is sub-second; a blocked shadow would show up
      // as multi-second latency (retries on the dead provider). 2s is generous.
      expect(elapsedMs).toBeLessThan(2_000);

      // Give the fire-and-forget shadow ample time to fail — then: no row for
      // the dead candidate (swallowed = missing row + warn/metric only).
      const completionId = res.json().id as string;
      await new Promise((r) => setTimeout(r, 1_500));
      const rows = await listShadowResults(app.potion.db.db, ORG_A, { fromDay: utcDay(), toDay: utcDay() });
      expect(rows.filter((r) => r.requestId === completionId)).toHaveLength(0);

      // Server still healthy + still serving after the shadow blew up.
      const health = await app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
      const again = await chat(app);
      expect(again.res.statusCode).toBe(200);
      expect(Date.now() - t0).toBeLessThan(10_000);
    }, 30_000);
  });

  describe('hanging candidate provider (hangMs — the "instance kill" freeze)', () => {
    const HANG_MS = 4_000;
    let app: App;
    beforeAll(async () => {
      app = await buildShadowApp(chaosProvider({ failRate: 0, hangMs: HANG_MS, seed: 7 }));
    }, 90_000);
    afterAll(async () => {
      await app.close();
    });

    it('response returns far inside the hang window; the row lands after the hang resolves', async () => {
      const { res, elapsedMs } = await chat(app);
      expect(res.statusCode).toBe(200);
      expect(elapsedMs).toBeLessThan(HANG_MS); // primary unaffected by the frozen candidate

      const completionId = res.json().id as string;
      const deadline = Date.now() + HANG_MS + 9_000;
      let rows = await listShadowResults(app.potion.db.db, ORG_A, { fromDay: utcDay(), toDay: utcDay() });
      while (!rows.some((r) => r.requestId === completionId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        rows = await listShadowResults(app.potion.db.db, ORG_A, { fromDay: utcDay(), toDay: utcDay() });
      }
      const mine = rows.filter((r) => r.requestId === completionId);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.candidateHash).toBe(strategyHash(CANDIDATE_CFG));
    }, 30_000);
  });
});
