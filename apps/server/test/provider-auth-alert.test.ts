// provider_auth alert (2026-09-19): a provider refusing our credentials on the
// serving path fails every completion until a person acts, and /readyz stays
// green. The first refusal emits one alert; the same incident does not spam.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { ProviderAuthError, ProviderError } from '@potion/providers';
import { buildServer } from '../src/server.js';
import { isProviderAuthFailure, resetProviderAuthAlerts } from '../src/routes/chat.js';

const ORG = 'org-provider-auth';
const KEY = 'pk_provider_auth';
const ONLY = { type: 'single', model: 'mock-mid' } as const;
let app: FastifyInstance;
const enqueued: Array<{ kind: string; payload: unknown }> = [];

function point(clusterId: string, cfg: FrontierPoint['strategyConfig']): FrontierPoint {
  return { clusterId, strategyHash: strategyHash(cfg), strategyConfig: cfg, quality: 0.9, costPer1K: 0.2, latencyP95: 400, providerMode: 'mock' };
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Provider Auth' });
  await insertPolicy(db, { id: 'pol-pa', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-pa', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-pa' });
  await saveFrontier(db, 'code-gen', [point('code-gen', ONLY)], 'manual', 'test-prices');
  // Every model call is refused the way OpenRouter refuses an exhausted key.
  const real = app.potion.providersForOrg;
  app.potion.providersForOrg = async (orgId: string) => {
    const set = await real(orgId);
    const refusing = {
      ...set.providers.mock,
      complete: async () => { throw new ProviderAuthError('mock', "provider 'mock': authentication failed: Key limit exceeded (total limit)"); },
    };
    const providers = { ...set.providers, mock: refusing };
    return { ...set, providers, resolve: (m: string) => { const r = set.resolve(m); return r.provider.id === 'mock' ? { ...r, provider: refusing } : r; } };
  };
  // Alerts go through the queue; record what is enqueued.
  const q = app.potion.queue;
  if (q) {
    // Record instead of dispatching: the test is about the EDGE, not delivery.
    q.enqueue = (async (kind: string, payload: unknown) => { enqueued.push({ kind, payload }); return `job-${enqueued.length}`; }) as typeof q.enqueue;
  }
});
afterAll(async () => {
  await app.close();
});

const post = () => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'code-gen' }, payload: { model: 'potion-auto', max_tokens: 50, messages: [{ role: 'user', content: 'Write a function that adds two numbers.' }] } });

describe('isProviderAuthFailure', () => {
  it('recognises the auth error class and the provider phrasings', () => {
    expect(isProviderAuthFailure(new ProviderAuthError('openrouter', 'no key'))).toBe(true);
    expect(isProviderAuthFailure(new Error('provider \'openrouter\': authentication failed: Key limit exceeded (total limit)'))).toBe(false); // not a ProviderError
    expect(isProviderAuthFailure(null)).toBe(false);
    // the account-balance refusal (2026-09-20), which is a plain ProviderError, not an auth class
    expect(isProviderAuthFailure(new ProviderError('openrouter', "provider 'openrouter': request failed: This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.", { kind: 'client_4xx' }))).toBe(true);
    expect(isProviderAuthFailure(new ProviderError('openrouter', "provider 'openrouter': request timed out after 60000ms", { kind: 'timeout' }))).toBe(false);
  });
});

describe('serving under a refused key', () => {
  it('the first refusal emits ONE provider_auth alert; the next request in the same incident emits none', async () => {
    resetProviderAuthAlerts();
    enqueued.length = 0;
    const first = await post();
    expect(first.statusCode).toBe(503);
    const alerts = () => enqueued.filter((e) => e.kind === 'alerts:dispatch' && (e.payload as { event?: string }).event === 'provider_auth');
    expect(alerts()).toHaveLength(1);
    expect((alerts()[0]!.payload as { detail: { provider: string; message: string } }).detail.message).toMatch(/Key limit exceeded/);
    const second = await post();
    expect(second.statusCode).toBe(503);
    expect(alerts()).toHaveLength(1);
  });
});
