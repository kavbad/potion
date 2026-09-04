// Learning-period sampling — consent, caps, redaction, and (2026-09-01, G1)
// FULL-REQUEST CAPTURE: the whole served conversation lands in
// potion.messages (redacted, parts stripped), structural facts ride along,
// and an over-cap request is EXCLUDED ('too-large') rather than truncated
// into a different task.
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type ChatMessage, type FrontierPoint, type StrategyConfig } from '@potion/core';
import { createDb, migrate, createOrg, insertApiKey, insertPolicy, traceSpans, upsertOrgIncumbents } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';
import {
  LEARNING_SAMPLE_MAX_PROMPT_CHARS,
  LEARNING_SPAN_NAME,
  learningSampleCounts,
  maybeKeepLearningSample,
} from '../src/learning/sampling.js';

function sample(n: number, over: Record<string, unknown> = {}) {
  return {
    orgId: 'org-s',
    requestId: `r${n}`,
    clusterId: 'classification',
    model: 'or-gpt-mini',
    messages: [
      { role: 'user', content: `Is this positive? Email me at jane.doe@example.com · ${n}` },
    ] as ChatMessage[],
    completion: 'negative',
    toolCount: 0,
    responseFormat: null,
    costUsd: 0.00002,
    usage: { inputTokens: 10 },
    ...over,
  };
}

describe('learning-period sampling', () => {
  it('no consent → no rows; consent → a redacted row; the per-cluster cap holds', async () => {
    const h = await createDb();
    await migrate(h.db);
    await createOrg(h.db, { id: 'org-s', name: 'S' });
    expect(await maybeKeepLearningSample(h.db, sample(0))).toBe('no-consent');
    await upsertOrgIncumbents(h.db, { orgId: 'org-s', models: ['or-gpt-full'], other: null, samplingConsent: false });
    expect(await maybeKeepLearningSample(h.db, sample(0))).toBe('no-consent');
    await upsertOrgIncumbents(h.db, { orgId: 'org-s', models: ['or-gpt-full'], other: null, samplingConsent: true });
    expect(await maybeKeepLearningSample(h.db, sample(0))).toBe('kept');
    const rows = await h.db.select().from(traceSpans).where(and(eq(traceSpans.orgId, 'org-s'), eq(traceSpans.name, LEARNING_SPAN_NAME)));
    expect(rows).toHaveLength(1);
    const attrs = rows[0]!.attrs as Record<string, unknown>;
    expect(attrs['gen_ai.prompt']).not.toContain('jane.doe@example.com');
    expect(attrs['potion.cluster_id']).toBe('classification');
    // the cap: 40 per cluster by default
    for (let i = 1; i < 45; i++) await maybeKeepLearningSample(h.db, sample(i));
    expect((await learningSampleCounts(h.db, 'org-s')).classification).toBe(40);
    expect(await maybeKeepLearningSample(h.db, sample(99))).toBe('cap');
    await h.close();
  });

  it('FULL-REQUEST capture: the whole conversation lands in potion.messages, every string leaf redacted', async () => {
    const h = await createDb();
    await migrate(h.db);
    await createOrg(h.db, { id: 'org-s', name: 'S' });
    await upsertOrgIncumbents(h.db, { orgId: 'org-s', models: ['or-gpt-full'], other: null, samplingConsent: true });
    const conversation: ChatMessage[] = [
      { role: 'system', content: 'You are a support classifier for jane.doe@example.com.' },
      { role: 'user', content: 'Earlier context turn.' },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: 'Classify this ticket.' },
    ];
    expect(await maybeKeepLearningSample(h.db, sample(0, { messages: conversation }))).toBe('kept');
    const rows = await h.db.select().from(traceSpans).where(and(eq(traceSpans.orgId, 'org-s'), eq(traceSpans.name, LEARNING_SPAN_NAME)));
    const attrs = rows[0]!.attrs as Record<string, unknown>;
    const stored = attrs['potion.messages'] as Array<{ role: string; content: string }>;
    expect(stored).toHaveLength(4);
    expect(stored.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(stored[0]!.content).not.toContain('jane.doe@example.com'); // system turns are redacted too
    expect(stored[3]!.content).toBe('Classify this ticket.');
    // legacy pair still present (display + old consumers): the LAST USER turn
    expect(attrs['gen_ai.prompt']).toBe('Classify this ticket.');
    expect(attrs['potion.tool_count']).toBe(0);
    await h.close();
  });

  it('structural facts ride along: tool count, response_format; multimodal parts are STRIPPED and counted', async () => {
    const h = await createDb();
    await migrate(h.db);
    await createOrg(h.db, { id: 'org-s', name: 'S' });
    await upsertOrgIncumbents(h.db, { orgId: 'org-s', models: ['or-gpt-full'], other: null, samplingConsent: true });
    const withParts: ChatMessage[] = [
      { role: 'user', content: 'what is in this image?', parts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ];
    expect(
      await maybeKeepLearningSample(h.db, sample(0, { messages: withParts, toolCount: 2, responseFormat: 'json_object' })),
    ).toBe('kept');
    const rows = await h.db.select().from(traceSpans).where(and(eq(traceSpans.orgId, 'org-s'), eq(traceSpans.name, LEARNING_SPAN_NAME)));
    const attrs = rows[0]!.attrs as Record<string, unknown>;
    expect(attrs['potion.tool_count']).toBe(2);
    expect(attrs['potion.response_format']).toBe('json_object');
    expect(attrs['potion.multimodal_parts']).toBe(1);
    // the base64 payload never reaches rest
    expect(JSON.stringify(attrs)).not.toContain('base64,AAAA');
    await h.close();
  });

  it("over-cap requests are EXCLUDED ('too-large'), never truncated into a different task", async () => {
    const h = await createDb();
    await migrate(h.db);
    await createOrg(h.db, { id: 'org-s', name: 'S' });
    await upsertOrgIncumbents(h.db, { orgId: 'org-s', models: ['or-gpt-full'], other: null, samplingConsent: true });
    const huge = 'x'.repeat(LEARNING_SAMPLE_MAX_PROMPT_CHARS + 1);
    expect(await maybeKeepLearningSample(h.db, sample(0, { messages: [{ role: 'user', content: huge }] }))).toBe('too-large');
    expect(await maybeKeepLearningSample(h.db, sample(1, { completion: 'y'.repeat(20_000) }))).toBe('too-large');
    const rows = await h.db.select().from(traceSpans).where(eq(traceSpans.orgId, 'org-s'));
    expect(rows).toHaveLength(0);
    await h.close();
  });
});

describe('the serve path captures the full request (closure wiring)', () => {
  const ORG = 'org-sample-e2e';
  const KEY = 'pk_sample_e2e';
  const CHEAP = { type: 'single', model: 'mock-cheap' } as const;
  let app: FastifyInstance;

  function point(cfg: StrategyConfig, quality: number, costPer1K: number): FrontierPoint {
    return { clusterId: 'classification', strategyHash: strategyHash(cfg), strategyConfig: cfg, quality, costPer1K, latencyP95: 300, providerMode: 'mock' };
  }

  beforeAll(async () => {
    app = await buildServer({ seed: false });
    const db = app.potion.db.db;
    await createOrg(db, { id: ORG, name: 'SampleE2E' });
    await insertPolicy(db, { id: 'pol-sample-e2e', orgId: ORG, name: 's', config: { type: 'min_cost', qualityFloor: 0.7 } });
    await insertApiKey(db, { id: 'key-sample-e2e', keyHash: sha256(KEY), name: 'serve', orgId: ORG, policyId: 'pol-sample-e2e' });
    await saveFrontier(db, 'classification', [point(CHEAP, 0.8, 0.2)], 'manual', 'test-prices');
    await upsertOrgIncumbents(db, { orgId: ORG, models: ['mock-cheap'], other: null, samplingConsent: true });
  });
  afterAll(async () => {
    await app.close();
  });

  it('a served request lands as a span with the system turn and both user turns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-potion-cluster': 'classification' },
      payload: {
        model: 'potion-auto',
        messages: [
          { role: 'system', content: 'You label tickets.' },
          { role: 'user', content: 'Prior turn.' },
          { role: 'assistant', content: 'Noted.' },
          { role: 'user', content: 'Urgent or routine?' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const db = app.potion.db.db;
    // fire-and-forget: poll for the span
    const deadline = Date.now() + 9000;
    let rows: Array<{ attrs: unknown }> = [];
    while (rows.length === 0 && Date.now() < deadline) {
      rows = await db.select().from(traceSpans).where(and(eq(traceSpans.orgId, ORG), eq(traceSpans.name, LEARNING_SPAN_NAME)));
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows).toHaveLength(1);
    const attrs = rows[0]!.attrs as Record<string, unknown>;
    const stored = attrs['potion.messages'] as Array<{ role: string; content: string }>;
    expect(stored.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(stored[0]!.content).toBe('You label tickets.');
    expect(attrs['potion.tool_count']).toBe(0);
  });
});
