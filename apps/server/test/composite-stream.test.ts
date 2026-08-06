// M3 #23 composite SSE integration tests (SPEC §12.6): POST
// /v1/chat/completions with stream:true on a frontier whose selected point is
// a `composite` strategy → ONE coherent OpenAI-shaped SSE token stream
// (chat.completion.chunk deltas + [DONE]); the keep/upgrade decision is on
// x-frontier-trace as upgraded=0|1, never in the stream. Determinism via the
// `[[mock-confidence:x]]` prompt marker (TEST/CI SIMULATION ONLY).
// PGlite in-memory, zero network/services.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sha256, strategyHash, type FrontierPoint } from '@potion/core';
import { DEFAULT_ORG_ID, insertApiKey, insertPolicy } from '@potion/db';
import { saveFrontier } from '@potion/pareto';
import { buildServer } from '../src/server.js';

const CFG_COMPOSITE = {
  type: 'composite',
  startModel: 'mock-cheap',
  upgradeModel: 'mock-frontier',
  upgradeIf: { confidenceBelow: 0.6 },
} as const;
const H_COMPOSITE = strategyHash(CFG_COMPOSITE).slice(0, 8);

const KEY_COMP = 'pk_test_composite_stream';
const CODE_PROMPT = 'Write a python function that reverses a string';

let app: FastifyInstance;

async function chat(payload: Record<string, unknown>, prompt: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY_COMP}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', messages: [{ role: 'user', content: prompt }], ...payload },
  });
}

function sseFrames(body: string): Array<Record<string, any> | '[DONE]'> {
  return body
    .split('\n\n')
    .filter((f) => f.trim() !== '')
    .map((f) => {
      const data = f.replace(/^data: /, '');
      return data === '[DONE]' ? '[DONE]' : (JSON.parse(data) as Record<string, any>);
    });
}

beforeAll(async () => {
  app = await buildServer({ seed: false });
  const db = app.potion.db.db;
  await insertPolicy(db, {
    id: 'pol-comp',
    orgId: DEFAULT_ORG_ID,
    name: 'pol-comp',
    config: { type: 'max_quality', costCeilingPer1K: 1000 },
  });
  await insertApiKey(db, {
    id: 'key-comp',
    keyHash: sha256(KEY_COMP),
    name: 'key-comp',
    orgId: DEFAULT_ORG_ID,
    policyId: 'pol-comp',
  });
  const point: FrontierPoint = {
    clusterId: 'code-gen',
    strategyHash: strategyHash(CFG_COMPOSITE),
    strategyConfig: CFG_COMPOSITE,
    quality: 0.88,
    costPer1K: 2.5,
    latencyP95: 2100,
  };
  await saveFrontier(db, 'code-gen', [point], 'manual', '2026-08-04');
}, 90_000);

afterAll(async () => {
  await app.close();
});

describe('composite SSE relay (M3 #23, SPEC §12.6)', () => {
  it('kept (high confidence): coherent SSE stream, [DONE], upgraded=0 in trace header', async () => {
    const res = await chat({ stream: true }, `${CODE_PROMPT} [[mock-confidence:0.95]]`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-frontier-trace']).toBe(
      `cluster=code-gen;strategy=${H_COMPOSITE};frontier=v1;policy=max_quality;fallback=0;` +
        `provenance=mock;upgraded=0`,
    );

    const frames = sseFrames(res.body);
    expect(frames.length).toBeGreaterThanOrEqual(4); // role + ≥1 content + stop + [DONE]
    expect(frames[frames.length - 1]).toBe('[DONE]');

    const first = frames[0] as any;
    expect(first.object).toBe('chat.completion.chunk');
    expect(first.choices[0].delta.role).toBe('assistant');
    expect(first.choices[0].finish_reason).toBeNull();

    const stop = frames[frames.length - 2] as any;
    expect(stop.choices[0].finish_reason).toBe('stop');

    const content = (frames.slice(1, -2) as any[])
      .map((f) => {
        expect(f.choices[0].index).toBe(0);
        expect(f.choices[0].finish_reason).toBeNull();
        return f.choices[0].delta.content as string;
      })
      .join('');
    expect(content).toContain('[mock:mock-cheap]');
    expect(content).not.toContain('[mock:mock-frontier]'); // no upgrade fired
  });

  it('upgraded (low confidence): single coherent stream across the switch, upgraded=1', async () => {
    const res = await chat({ stream: true }, `${CODE_PROMPT} [[mock-confidence:0.20]]`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-frontier-trace']).toContain(`strategy=${H_COMPOSITE}`);
    expect(res.headers['x-frontier-trace']).toMatch(/;upgraded=1$/);

    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]).toBe('[DONE]');
    const contentFrames = frames.slice(1, -2) as any[];
    for (const f of contentFrames) {
      expect(f.object).toBe('chat.completion.chunk');
      expect(f.choices[0].finish_reason).toBeNull();
      expect(typeof f.choices[0].delta.content).toBe('string');
    }
    const content = contentFrames.map((f) => f.choices[0].delta.content as string).join('');
    // Buffered start-model prefix + upgrade-model continuation, seamlessly:
    expect(content).toContain('[mock:mock-cheap]');
    expect(content).toContain('[mock:mock-frontier]');
    expect(content.indexOf('[mock:mock-cheap]')).toBeLessThan(content.indexOf('[mock:mock-frontier]'));
    // No meta-commentary leaks into the client stream.
    expect(content).not.toContain('cheaper model produced');
    expect(content).not.toContain('continue/improve');
  });

  it('stream_options.include_usage → final usage-only chunk before [DONE] (#25 parity)', async () => {
    const res = await chat(
      { stream: true, stream_options: { include_usage: true } },
      `${CODE_PROMPT} [[mock-confidence:0.95]]`,
    );
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res.body);
    expect(frames[frames.length - 1]).toBe('[DONE]');
    const usage = frames[frames.length - 2] as any;
    expect(usage.object).toBe('chat.completion.chunk');
    expect(usage.choices).toEqual([]);
    expect(usage.usage.total_tokens).toBeGreaterThan(0);
    expect(usage.usage.total_tokens).toBe(usage.usage.prompt_tokens + usage.usage.completion_tokens);
    const stop = frames[frames.length - 3] as any;
    expect(stop.choices[0].finish_reason).toBe('stop');
  });

  it('non-stream composite: 200 JSON (OpenAI shape) with upgraded flag on the trace header', async () => {
    const res = await chat({}, `${CODE_PROMPT} [[mock-confidence:0.20]]`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-frontier-trace']).toMatch(/;upgraded=1$/);
    const body = res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].message.role).toBe('assistant');
    // Non-stream contract: final = upgraded text only.
    expect(body.choices[0].message.content).toContain('[mock:mock-frontier]');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });
});
