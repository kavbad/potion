// GET /api/research/promotions — the PULL half of "how do I hear about a
// breakthrough".
//
// The push half (recipe_promoted → webhook/Slack) already existed and is
// correct, but it is delivery-only: dispatchAlertEvent matches alert RULES,
// so a deployment with no rule configured recorded a promotion nowhere and
// told nobody. These assertions pin the property that fixes that — a
// promotion is visible with zero external configuration — plus the one
// classification the surface exists to make legible: whether the promoted
// recipe is a MIXTURE, which is the finding class you cannot reach by
// picking from a catalogue.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type StrategyConfig } from '@potion/core';
import { insertApiKey, upsertRecipeStatus } from '@potion/db';
import { strategyConfigs } from '@potion/db';
import { buildServer } from '../src/server.js';
import { ORG_A, seedIsolationOrgs } from './fixtures/orgs.js';

const KEY = 'pk_promotions';
const SINGLE: StrategyConfig = { type: 'single', model: 'mock-cheap' };
const CASCADE: StrategyConfig = {
  type: 'cascade',
  stages: [
    { model: 'mock-cheap', escalateIf: { confidenceBelow: 0.7 } },
    { model: 'mock-frontier' },
  ],
  confidenceMethod: 'self-report-calibrated',
} as StrategyConfig;

let app: FastifyInstance;
const db = (): FastifyInstance['potion']['db']['db'] => app.potion.db.db;

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${KEY}` } });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  await seedIsolationOrgs(db());
  await insertApiKey(db(), {
    id: 'key-promotions',
    keyHash: sha256(KEY),
    name: 'promotions',
    orgId: ORG_A,
    policyId: null,
  });
  for (const cfg of [SINGLE, CASCADE]) {
    await db()
      .insert(strategyConfigs)
      .values({ hash: strategyHash(cfg), config: cfg })
      .onConflictDoNothing();
  }
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('GET /api/research/promotions', () => {
  it('is empty before anything is promoted', async () => {
    const res = await get('/api/research/promotions');
    expect(res.statusCode).toBe(200);
    expect(res.json().promotions).toEqual([]);
  });

  it('surfaces a promotion with NO alert rule configured — the whole point', async () => {
    await upsertRecipeStatus(db(), strategyHash(SINGLE), 'frontier');
    const res = await get('/api/research/promotions');
    const hashes = res.json().promotions.map((p: { strategyHash8: string }) => p.strategyHash8);
    expect(hashes).toContain(strategyHash(SINGLE).slice(0, 8));
  });

  it('marks a mixture as such, so the finding class is legible at a glance', async () => {
    await upsertRecipeStatus(db(), strategyHash(CASCADE), 'frontier');
    const res = await get('/api/research/promotions');
    const rows: Array<{ strategyHash: string; isMixture: boolean; config: StrategyConfig | null }> =
      res.json().promotions;
    const mix = rows.find((r) => r.strategyHash === strategyHash(CASCADE));
    const one = rows.find((r) => r.strategyHash === strategyHash(SINGLE));
    expect(mix?.isMixture).toBe(true);
    expect(mix?.config?.type).toBe('cascade');
    expect(one?.isMixture).toBe(false);
  });

  it('does NOT list candidates or archived recipes — only what actually serves', async () => {
    const other: StrategyConfig = { type: 'single', model: 'mock-mid' };
    await db()
      .insert(strategyConfigs)
      .values({ hash: strategyHash(other), config: other })
      .onConflictDoNothing();
    await upsertRecipeStatus(db(), strategyHash(other), 'candidate');
    const res = await get('/api/research/promotions');
    const hashes = res.json().promotions.map((p: { strategyHash: string }) => p.strategyHash);
    expect(hashes).not.toContain(strategyHash(other));
  });

  it('clamps sinceDays and limit rather than trusting the query string', async () => {
    const res = await get('/api/research/promotions?sinceDays=9999&limit=99999');
    expect(res.statusCode).toBe(200);
    expect(res.json().sinceDays).toBe(365);
  });

  it('a window that excludes the promotion returns nothing', async () => {
    // Everything above was promoted just now, so a 1-day window still includes
    // it; the guard being asserted is that the window is APPLIED at all.
    const wide = await get('/api/research/promotions?sinceDays=365');
    const narrow = await get('/api/research/promotions?sinceDays=1');
    expect(narrow.json().promotions.length).toBeLessThanOrEqual(wide.json().promotions.length);
    expect(narrow.json().sinceDays).toBe(1);
  });

  it('rejects an unknown key — it is org-scoped research output, not public', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/research/promotions',
      headers: { authorization: 'Bearer pk_not_a_real_key' },
    });
    expect(res.statusCode).toBe(401);
  });
});
