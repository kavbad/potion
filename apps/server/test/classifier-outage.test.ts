// P0-1 (external review, 2026-09-05): the classifier is not allowed to take
// serving down.
//
// The embed call is the hardest dependency on the serve path — every
// classified request waits on it — and it had no resilience and no try/catch.
// An embeddings outage or hang became a bare 500 for EVERY org, including
// orgs whose traffic routes entirely to another provider. That is the failure
// class the product sells protection against, sitting in front of the product.
//
// Done when: an injected outage serves the request under the `general`
// frontier with the fallback labeled on the trace.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256 } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy } from '@potion/db';
import { buildServer } from '../src/server.js';

const KEY = 'pk_test_classifier_outage';
let app: FastifyInstance;

async function chat(content = 'Write a python function that reverses a string') {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content }] },
  });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await insertPolicy(db, {
    id: 'pol-outage', orgId: DEFAULT_ORG_ID, name: 'pol-outage',
    config: { type: 'max_quality', costCeilingPer1K: 1000 },
  });
  await insertApiKey(db, {
    id: 'key-outage', keyHash: sha256(KEY), name: 'key-outage',
    orgId: DEFAULT_ORG_ID, policyId: 'pol-outage',
  });
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('an embedder outage degrades instead of failing', () => {
  it('serves under the general frontier and LABELS the trace', async () => {
    const real = app.potion.assigner.assignRanked.bind(app.potion.assigner);
    app.potion.assigner.assignRanked = async () => {
      throw new Error("provider 'openai': embeddings unavailable");
    };
    try {
      const res = await chat();
      expect(res.statusCode).toBe(200); // NOT a 500
      const trace = res.headers['x-frontier-trace'] as string;
      expect(trace).toContain('cluster=general');
      expect(trace).toContain('classifier=unavailable');
    } finally {
      app.potion.assigner.assignRanked = real;
    }
  });

  it('a HUNG embedder does not hang the request', async () => {
    const real = app.potion.assigner.assignRanked.bind(app.potion.assigner);
    // The resilience wrapper's deadline is what makes this terminate; before
    // P0-1 an unsettling embed hung the caller forever (it hung this suite).
    app.potion.assigner.assignRanked = () =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('embed timed out after 50ms')), 50));
    try {
      const started = Date.now();
      const res = await chat();
      expect(res.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(res.headers['x-frontier-trace']).toContain('classifier=unavailable');
    } finally {
      app.potion.assigner.assignRanked = real;
    }
  });

  it('a healthy classifier carries NO label — ordinary traffic is unchanged', async () => {
    const res = await chat();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frontier-trace']).not.toContain('classifier=');
  });
});
