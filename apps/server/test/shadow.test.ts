// Shadow mode tests (M3, ROADMAP #21, SPEC §12.4).
//   · shouldSample / shadowScore / candidate resolution (pure + db lookups)
//   · runShadow: sampled request → shadow_results rows (≤2 candidates),
//     candidate failure swallowed, 'frontier' vs explicit-hash resolution
//   · serving integration: POST /v1/chat/completions with a shadow policy →
//     200 + normal trace + rows appear; sampleRate 0 → none, 1 → all;
//     org isolation; response latency NOT blocked by a slow (hanging)
//     shadow candidate (chaos provider, timeout-guarded).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint, type Policy, type StrategyConfig } from '@potion/core';
import {
  DEFAULT_ORG_ID,
  createOrg,
  insertApiKey,
  insertPolicy,
  listShadowResults,
  upsertStrategyConfig,
  utcDay,
} from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { chaosProvider, createMockProvider, type Provider } from '@potion/providers';
import { loadPrices } from '@potion/providers';
import { buildServer } from '../src/server.js';
import { DEFAULT_PRICES_PATH } from '../src/context.js';
import {
  MAX_SHADOW_CANDIDATES,
  candidateModelOf,
  resolveShadowCandidates,
  runShadow,
  shadowScore,
  shouldSample,
} from '../src/shadow.js';

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = 'org_shadow_b';

const CFG_CHEAP = { type: 'single', model: 'mock-cheap' } as const;
const CFG_MID = { type: 'single', model: 'mock-mid' } as const;
const CFG_STRONG = { type: 'single', model: 'mock-frontier' } as const;
const CFG_BAD = { type: 'single', model: 'no-such-model-anywhere' } as const;

const H_CHEAP = strategyHash(CFG_CHEAP);
const H_MID = strategyHash(CFG_MID);
const H_STRONG = strategyHash(CFG_STRONG);
const H_BAD = strategyHash(CFG_BAD);

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

const POINTS: FrontierPoint[] = [
  point(CFG_CHEAP, 0.5, 0.1),
  point(CFG_MID, 0.7, 1.0),
  point(CFG_STRONG, 0.9, 10.0),
];

const CODE_PROMPT = 'Write a python function that reverses a string';

const KEY_FRONTIER = 'pk_shadow_frontier'; // min_cost floor 0 → cheap primary; candidates 'frontier'
const KEY_EXPLICIT = 'pk_shadow_explicit'; // explicit hashes incl. a failing candidate
const KEY_ZERO = 'pk_shadow_zero'; // sampleRate 0
const KEY_B = 'pk_shadow_org_b'; // org B, sampleRate 1
const KEY_PLAIN = 'pk_shadow_plain'; // no shadow config

let app: FastifyInstance;
const db = () => app.potion.db.db;
const today = () => ({ fromDay: utcDay(), toDay: utcDay() });

async function policy(id: string, orgId: string, key: string, config: Policy): Promise<void> {
  await insertPolicy(db(), { id, orgId, name: id, config });
  await insertApiKey(db(), {
    id: `key-${id}`,
    keyHash: sha256(key),
    name: id,
    orgId,
    policyId: id,
  });
}

async function chat(rawKey: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }], ...payload },
  });
}

async function rowsFor(orgId: string) {
  return listShadowResults(db(), orgId, today());
}

/** Poll until pred holds or the deadline passes (shadow work is async). */
async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 9000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!pred(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await saveFrontier(db(), 'code-gen', POINTS, 'manual', '2026-08-04');
  await createOrg(db(), { id: ORG_B, name: 'Shadow Org B' });

  // min_cost floor 0 → the cheapest point (mock-cheap) serves as primary.
  await policy('pol-shadow-frontier', ORG_A, KEY_FRONTIER, {
    type: 'min_cost',
    qualityFloor: 0,
    shadow: { sampleRate: 1, candidates: 'frontier' },
  });
  await policy('pol-shadow-explicit', ORG_A, KEY_EXPLICIT, {
    type: 'min_cost',
    qualityFloor: 0,
    shadow: { sampleRate: 1, candidates: [H_MID, H_BAD] },
  });
  await policy('pol-shadow-zero', ORG_A, KEY_ZERO, {
    type: 'min_cost',
    qualityFloor: 0,
    shadow: { sampleRate: 0, candidates: 'frontier' },
  });
  await policy('pol-shadow-b', ORG_B, KEY_B, {
    type: 'min_cost',
    qualityFloor: 0,
    shadow: { sampleRate: 1, candidates: 'frontier' },
  });
  await policy('pol-shadow-plain', ORG_A, KEY_PLAIN, { type: 'min_cost', qualityFloor: 0 });

  // The failing candidate's config lives ONLY in strategy_configs (explicit-
  // hash db lookup path); 'no-such-model-anywhere' fails at resolve() time.
  await upsertStrategyConfig(db(), H_BAD, CFG_BAD);
}, 90_000);

afterAll(async () => {
  await app.close();
});

// ---------- pure helpers ----------

describe('shouldSample', () => {
  it('samples deterministically against an injected rand', () => {
    expect(shouldSample({ sampleRate: 0, candidates: 'frontier' }, () => 0)).toBe(false);
    expect(shouldSample({ sampleRate: 1, candidates: 'frontier' }, () => 0.999)).toBe(true);
    expect(shouldSample({ sampleRate: 0.5, candidates: 'frontier' }, () => 0.49)).toBe(true);
    expect(shouldSample({ sampleRate: 0.5, candidates: 'frontier' }, () => 0.5)).toBe(false);
  });
});

describe('shadowScore (deterministic in-process scorer)', () => {
  it('is 1 for identical texts, 0 for disjoint token sets, in (0,1) for partial overlap', () => {
    expect(shadowScore('the quick brown fox', 'the quick brown fox')).toBe(1);
    expect(shadowScore('the quick brown fox', 'completely different words here')).toBe(0);
    const partial = shadowScore('the quick brown fox', 'the quick red fox');
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    // deterministic: normalization makes case/whitespace irrelevant
    expect(shadowScore('The   QUICK brown fox', 'the quick brown fox')).toBe(1);
  });
});

describe('candidateModelOf', () => {
  it('labels each strategy type', () => {
    expect(candidateModelOf(CFG_CHEAP)).toBe('mock-cheap');
    expect(
      candidateModelOf({
        type: 'cascade',
        stages: [{ model: 'a' }, { model: 'b' }],
        confidenceMethod: 'logprob',
      }),
    ).toBe('a→b');
  });
});

// ---------- candidate resolution ----------

describe('resolveShadowCandidates', () => {
  const frontier = { points: POINTS } as never; // only .points is read

  it("'frontier' picks the OTHER points, capped at MAX_SHADOW_CANDIDATES", async () => {
    const candidates = await resolveShadowCandidates(app.potion, {
      shadow: { sampleRate: 1, candidates: 'frontier' },
      frontier,
      primary: { hash: H_CHEAP, text: '' },
    });
    expect(candidates.map((c) => c.hash)).toEqual([H_MID, H_STRONG]);
    expect(candidates.length).toBeLessThanOrEqual(MAX_SHADOW_CANDIDATES);
  });

  it('explicit hashes resolve via frontier points first, then strategy_configs; unknown skipped', async () => {
    const candidates = await resolveShadowCandidates(app.potion, {
      shadow: { sampleRate: 1, candidates: [H_MID, H_BAD, 'unknown-hash-123'] },
      frontier,
      primary: { hash: H_CHEAP, text: '' },
    });
    expect(candidates.map((c) => c.hash)).toEqual([H_MID, H_BAD]); // unknown skipped, cap 2
    expect(candidates[1]!.config).toEqual(CFG_BAD); // from strategy_configs
  });

  it('never shadows the primary itself and dedupes hashes', async () => {
    const candidates = await resolveShadowCandidates(app.potion, {
      shadow: { sampleRate: 1, candidates: [H_CHEAP, H_MID, H_MID] },
      frontier,
      primary: { hash: H_CHEAP, text: '' },
    });
    expect(candidates.map((c) => c.hash)).toEqual([H_MID]);
  });
});

// ---------- runShadow (executor) ----------

describe('runShadow', () => {
  it('executes candidates and writes shadow_results rows (mock world, in-process scorer)', async () => {
    const orgProviders = await app.potion.providersForOrg(ORG_A);
    const before = (await rowsFor(ORG_A)).length;
    const outcomes = await runShadow(
      app.potion,
      {
        orgId: ORG_A,
        requestId: 'chatcmpl-unit-shadow-1',
        clusterId: 'code-gen',
        messages: [{ role: 'user', content: CODE_PROMPT }],
        primary: { hash: H_CHEAP, text: 'primary answer text' },
        shadow: { sampleRate: 1, candidates: 'frontier' },
        frontier: { points: POINTS } as never,
        orgProviders,
      },
      () => {},
    );
    expect(outcomes).toHaveLength(2); // mid + strong, capped at 2
    const rows = await rowsFor(ORG_A);
    expect(rows.length).toBe(before + 2);
    const mine = rows.filter((r) => r.requestId === 'chatcmpl-unit-shadow-1');
    expect(mine.map((r) => r.candidateHash).sort()).toEqual([H_MID, H_STRONG].sort());
    for (const r of mine) {
      expect(r.orgId).toBe(ORG_A);
      expect(r.clusterId).toBe('code-gen');
      expect(r.primaryHash).toBe(H_CHEAP);
      expect(r.quality).not.toBeNull(); // in-process scorer always writes
      expect(r.quality!).toBeGreaterThanOrEqual(0);
      expect(r.quality!).toBeLessThanOrEqual(1);
      expect(r.costUsd).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.latencyMs)).toBe(true);
    }
  });

  it('swallows a failing candidate — the other candidate still lands', async () => {
    const warnings: string[] = [];
    const orgProviders = await app.potion.providersForOrg(ORG_A);
    const outcomes = await runShadow(
      app.potion,
      {
        orgId: ORG_A,
        requestId: 'chatcmpl-unit-shadow-2',
        clusterId: 'code-gen',
        messages: [{ role: 'user', content: CODE_PROMPT }],
        primary: { hash: H_CHEAP, text: 'primary answer text' },
        shadow: { sampleRate: 1, candidates: [H_MID, H_BAD] },
        frontier: { points: POINTS } as never,
        orgProviders,
      },
      (msg) => warnings.push(msg),
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.candidate.hash).toBe(H_MID);
    expect(warnings.some((w) => w.includes('swallowed'))).toBe(true);
    const mine = (await rowsFor(ORG_A)).filter((r) => r.requestId === 'chatcmpl-unit-shadow-2');
    expect(mine.map((r) => r.candidateHash)).toEqual([H_MID]); // no row for the failure
  });
});

// ---------- serving integration ----------

describe('serving integration (POST /v1/chat/completions)', () => {
  it('shadow policy + sampleRate 1 → 200 + normal trace + rows appear after the response', async () => {
    const before = (await rowsFor(ORG_A)).length;
    const res = await chat(KEY_FRONTIER);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).toContain('cluster=code-gen');
    expect(res.json().choices[0].message.content).toBeTruthy();
    const completionId = res.json().id as string;
    // fire-and-forget: rows land shortly AFTER the response
    const rows = await waitFor(rowsFor.bind(null, ORG_A), (r) => r.length >= before + 2);
    const mine = rows.filter((r) => r.requestId === completionId);
    expect(mine.map((r) => r.candidateHash).sort()).toEqual([H_MID, H_STRONG].sort());
  });

  it('sampleRate 0 → never any rows', async () => {
    const before = (await rowsFor(ORG_A)).length;
    const res = await chat(KEY_ZERO);
    expect(res.statusCode).toBe(200);
    // generous settle window — a sampleRate-0 policy must produce NOTHING
    await new Promise((r) => setTimeout(r, 1500));
    expect((await rowsFor(ORG_A)).length).toBe(before);
  });

  it('explicit candidates: the failing one is swallowed, the response is unaffected', async () => {
    const res = await chat(KEY_EXPLICIT);
    expect(res.statusCode).toBe(200);
    const completionId = res.json().id as string;
    const rows = await waitFor(
      async () => (await rowsFor(ORG_A)).filter((r) => r.requestId === completionId),
      (r) => r.length >= 1,
    );
    expect(rows.map((r) => r.candidateHash)).toEqual([H_MID]); // H_BAD swallowed
  });

  it('no shadow config → no rows, no metric path touched', async () => {
    const before = (await rowsFor(ORG_A)).length;
    const res = await chat(KEY_PLAIN);
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 800));
    expect((await rowsFor(ORG_A)).length).toBe(before);
  });

  it('org isolation: org B traffic writes org B rows only', async () => {
    const beforeA = (await rowsFor(ORG_A)).length;
    const res = await chat(KEY_B);
    expect(res.statusCode).toBe(200);
    const completionId = res.json().id as string;
    const rowsB = await waitFor(
      async () => (await rowsFor(ORG_B)).filter((r) => r.requestId === completionId),
      (r) => r.length >= 2,
    );
    expect(rowsB.every((r) => r.orgId === ORG_B)).toBe(true);
    expect((await rowsFor(ORG_A)).length).toBe(beforeA); // org A untouched
  });

  it('stream:true triggers the shadow run AFTER [DONE] (stream path trigger point)', async () => {
    const res = await chat(KEY_FRONTIER, { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: [DONE]');
    const completionId = (res.body.match(/chatcmpl-[a-z0-9]+/) ?? [])[0]!;
    const rows = await waitFor(
      async () => (await rowsFor(ORG_A)).filter((r) => r.requestId === completionId),
      (r) => r.length >= 2,
    );
    expect(rows.map((r) => r.candidateHash).sort()).toEqual([H_MID, H_STRONG].sort());
  });

  it('observeShadow metric counts sampling decisions on shadow-policy requests', async () => {
    const before = (await rowsFor(ORG_A)).length;
    await chat(KEY_FRONTIER); // sampleRate 1 → sampled=1
    await chat(KEY_ZERO); // sampleRate 0 → sampled=0
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\n').filter((l) => l.startsWith('potion_shadow_decisions_total'));
    expect(lines.some((l) => l.includes('cluster_id="code-gen"') && l.includes('sampled="1"'))).toBe(true);
    expect(lines.some((l) => l.includes('cluster_id="code-gen"') && l.includes('sampled="0"'))).toBe(true);
    // settle so the fire-and-forget rows don't race a later test's baseline
    await waitFor(rowsFor.bind(null, ORG_A), (r) => r.length >= before + 2);
  });
});

// ---------- latency: shadow never blocks the primary ----------

describe('primary latency is not blocked by a slow shadow candidate', () => {
  const SLOW_CFG = { type: 'single', model: 'mock-cheap' } as const; // provider 'mock' → chaos hang
  const FAST_CFG = { type: 'single', model: 'gpt-mini-class' } as const; // provider 'openai' → fast mock
  const HANG_MS = 3000;
  let slowApp: FastifyInstance;

  beforeAll(async () => {
    const { table: prices } = loadPrices(DEFAULT_PRICES_PATH);
    const fast: Provider = createMockProvider(prices);
    // Chaos hang behind the 'mock' provider id (the candidate's provider);
    // embed borrowed from the fast mock so centroid boot still works.
    const chaos = chaosProvider({ failRate: 0, hangMs: HANG_MS, seed: 7 });
    const slow: Provider = { ...chaos, ...(fast.embed ? { embed: fast.embed.bind(fast) } : {}) };
    // Every provider id FAST except 'mock' — the shadow candidate's provider.
    slowApp = await buildServer({
      seed: false,
      providers: { anthropic: fast, openai: fast, google: fast, openrouter: fast, mock: slow },
    });
    const db2 = slowApp.potion.db.db;
    await saveFrontier(
      db2,
      'code-gen',
      [
        {
          clusterId: 'code-gen',
          strategyHash: strategyHash(FAST_CFG),
          strategyConfig: FAST_CFG,
          quality: 0.9,
          costPer1K: 1.0,
          latencyP95: 500,
        },
        {
          clusterId: 'code-gen',
          strategyHash: strategyHash(SLOW_CFG),
          strategyConfig: SLOW_CFG,
          quality: 0.5,
          costPer1K: 0.1,
          latencyP95: 5000,
        },
      ],
      'manual',
      '2026-08-04',
    );
    // max_quality ceiling 2 → only the fast point is feasible (primary).
    await insertPolicy(db2, {
      id: 'pol-shadow-slow',
      orgId: ORG_A,
      name: 'pol-shadow-slow',
      config: {
        type: 'max_quality',
        costCeilingPer1K: 2,
        shadow: { sampleRate: 1, candidates: 'frontier' },
      },
    });
    await insertApiKey(db2, {
      id: 'key-shadow-slow',
      keyHash: sha256('pk_shadow_slow'),
      name: 'slow',
      orgId: ORG_A,
      policyId: 'pol-shadow-slow',
    });
  }, 90_000);

  afterAll(async () => {
    await slowApp.close();
  });

  it(
    'response returns well before the hanging candidate finishes; the row lands later',
    { timeout: 30_000 },
    async () => {
      const t0 = Date.now();
      const res = await slowApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer pk_shadow_slow', 'content-type': 'application/json' },
        payload: { model: 'potion-auto', messages: [{ role: 'user', content: CODE_PROMPT }] },
      });
      const elapsedMs = Date.now() - t0;
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-frontier-trace']).toContain(`strategy=${strategyHash(FAST_CFG).slice(0, 8)}`);
      // The candidate hangs 3s; the primary must be far faster than that.
      expect(elapsedMs).toBeLessThan(HANG_MS);
      // …and the shadow row still lands once the candidate finishes.
      const completionId = res.json().id as string;
      const rows = await waitFor(
        async () =>
          (await listShadowResults(slowApp.potion.db.db, ORG_A, today())).filter(
            (r) => r.requestId === completionId,
          ),
        (r) => r.length >= 1,
        HANG_MS + 9000,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.candidateHash).toBe(strategyHash(SLOW_CFG));
    },
  );
});
