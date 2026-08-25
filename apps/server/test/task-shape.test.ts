// Flywheel groundwork (0055): the two un-backfillable columns.
//
// The load-bearing claims: (1) the shape is CONTENT-FREE — a distinctive
// prompt leaves no trace in its serialization; (2) silence is RECORDED —
// a completed request stamps an EMPTY array, never NULL, because the
// honesty term needs "nothing observed" to be distinguishable from "not
// instrumented" forever after.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { requestLogs } from '@potion/db';
import { sha256 } from '@potion/core';
import { createOrg, insertApiKey, insertPolicy } from '@potion/db';
import { buildServer } from '../src/server.js';
import { taskShapeOf } from '../src/routing/task-shape.js';

const ORG = 'org-shape';
const KEY = 'pk_shape_serve';
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({ seed: true }); // seeded: frontiers exist, mock serves
  const db = app.potion.db.db;
  await createOrg(db, { id: ORG, name: 'Shape Co' });
  await insertPolicy(db, { id: 'pol-shape', orgId: ORG, name: 'floor', config: { type: 'min_cost', qualityFloor: 0.5 } });
  await insertApiKey(db, { id: 'key-shape', keyHash: sha256(KEY), name: 'serve', orgId: ORG, scopes: 'serve', policyId: 'pol-shape' });
});
afterAll(async () => {
  await app.close();
});

describe('taskShapeOf is content-free by construction', () => {
  it('a distinctive prompt leaves NO trace in the serialized shape', () => {
    const marker = 'XyloquantverbaneTheSecretProjectNameNobodyKnows';
    const shape = taskShapeOf({
      messages: [
        { role: 'system', content: `You are ${marker}.` },
        { role: 'user', content: `Tell me about ${marker} and its ${marker}-adjacent plans.` },
      ],
      tools: [{ type: 'function', function: { name: `${marker}_tool`, description: marker } }],
      temperature: 0.3,
    });
    const serialized = JSON.stringify(shape).toLowerCase();
    expect(serialized).not.toContain(marker.toLowerCase());
    expect(serialized).not.toContain('secret');
    // yet the structure IS captured
    expect(shape).toMatchObject({ v: 1, msgs: 2, user: 1, system: 1, toolsN: 1, hasTemperature: true });
    expect(shape.charsIn).toBeGreaterThan(0);
    expect(shape.toolSig).toMatch(/^[0-9a-f]{12}$/);
  });

  it('the tool signature is a JOIN KEY: same toolset in any order, same sig; different toolset, different sig', () => {
    const a = taskShapeOf({ messages: [], tools: [{ function: { name: 'get_weather' } }, { function: { name: 'send_mail' } }] });
    const b = taskShapeOf({ messages: [], tools: [{ function: { name: 'send_mail' } }, { function: { name: 'get_weather' } }] });
    const c = taskShapeOf({ messages: [], tools: [{ function: { name: 'get_weather' } }] });
    expect(a.toolSig).toBe(b.toolSig);
    expect(a.toolSig).not.toBe(c.toolSig);
  });

  it('counts modality parts without touching them', () => {
    const shape = taskShapeOf({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:...' } }, { type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] },
      ],
      stream: true,
      response_format: { type: 'json_object' },
      max_tokens: 500,
    });
    expect(shape).toMatchObject({ imagesN: 1, audioN: 1, stream: true, jsonMode: true, maxTokens: 500 });
    expect(JSON.stringify(shape)).not.toContain('data:');
  });

  it('a malformed body yields an empty shape, never a throw', () => {
    expect(taskShapeOf(null).msgs).toBe(0);
    expect(taskShapeOf({ messages: 'nope', tools: 42 }).toolsN).toBe(0);
  });
});

describe('the row: stamped shape + recorded silence', () => {
  it('a served request lands with task_shape populated and implicit_signals [] — not NULL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { model: 'potion', messages: [{ role: 'user', content: 'Classify this: the invoice total is wrong.' }] },
    });
    expect(res.statusCode).toBe(200);
    const db = app.potion.db.db;
    const rows = await db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.orgId, ORG))
      .orderBy(desc(requestLogs.id))
      .limit(1);
    const row = rows[0]!;
    expect(row.status).toBe('ok');
    const shape = row.taskShape as Record<string, unknown>;
    expect(shape).toMatchObject({ v: 1, msgs: 1, user: 1 });
    expect(JSON.stringify(shape)).not.toContain('invoice');
    // The stamp is an ARRAY (never NULL on new rows) and it caught the one
    // thing this environment really does: the mock-seeded chain serves via
    // fallback, and the signal was recorded. Old rows stay NULL — that is
    // the not-instrumented/recorded-silence distinction, by schema default.
    expect(Array.isArray(row.implicitSignals)).toBe(true);
    expect(row.implicitSignals).toEqual(['fallback_no_frontier']);
  });

  it('a refused request still carries the shape (stamped before auth resolution)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer pk_wrong', 'content-type': 'application/json' },
      payload: { model: 'potion', messages: [{ role: 'user', content: 'hello there' }] },
    });
    expect(res.statusCode).toBe(401);
    const db = app.potion.db.db;
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.status, 'auth_failed')).orderBy(desc(requestLogs.id)).limit(1);
    expect((rows[0]!.taskShape as Record<string, unknown>).msgs).toBe(1);
  });
});

describe('the 0056 stamps: answer shape and fingerprints', () => {
  it('answerShapeOf is content-free and sees JSON validity', async () => {
    const { answerShapeOf } = await import('../src/routing/task-shape.js');
    const marker = 'ZekrilbanTheHiddenAnswer';
    const good = answerShapeOf({ text: `{"plan":"${marker}"}`, finishReason: 'stop' }, { jsonRequested: true, strategyType: 'single' });
    expect(JSON.stringify(good)).not.toContain(marker);
    expect(good).toMatchObject({ jsonValid: true, strategyType: 'single', finishReason: 'stop' });
    const bad = answerShapeOf({ text: `Sure! Here is JSON: {"a":1}` }, { jsonRequested: true });
    expect(bad.jsonValid).toBe(false);
    const noJson = answerShapeOf({ text: 'plain prose' }, { jsonRequested: false });
    expect(noJson.jsonValid).toBeNull();
  });

  // NOTE: this is a UNIT test of the salting function, not a server
  // tenancy probe — the isolation-fixture gate covers route-level tests.
  it('promptFingerprint: deterministic per salt, unrelated across salts, never the text', async () => {
    const { promptFingerprint } = await import('../src/routing/task-shape.js');
    const body = { messages: [{ role: 'user', content: 'the secret merger with Vexacorp' }] };
    const a1 = promptFingerprint('org-a', body);
    const a2 = promptFingerprint('org-a', body);
    const b1 = promptFingerprint('org-b', body);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(a1).toMatch(/^[0-9a-f]{16}$/);
    expect(a1).not.toContain('Vexacorp');
    expect(promptFingerprint('org-a', { messages: [] })).toBeNull();
  });

  it('sessionFingerprint hashes the user field per org; absent user → null', async () => {
    const { sessionFingerprint } = await import('../src/routing/task-shape.js');
    expect(sessionFingerprint('org-a', 'end-user-42')).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionFingerprint('org-a', 'end-user-42')).not.toBe(sessionFingerprint('org-b', 'end-user-42'));
    expect(sessionFingerprint('org-a', undefined)).toBeNull();
    expect(sessionFingerprint('org-a', '')).toBeNull();
  });

  it('the row carries all three: fp stamped, session null without user, answer_shape on success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      payload: { model: 'potion', messages: [{ role: 'user', content: 'Summarize the quarterly Vexacorp numbers.' }], user: 'sess-99' },
    });
    expect(res.statusCode).toBe(200);
    const db = app.potion.db.db;
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.orgId, ORG)).orderBy(desc(requestLogs.id)).limit(1);
    const row = rows[0]!;
    expect(row.promptFp).toMatch(/^[0-9a-f]{16}$/);
    expect(row.sessionFp).toMatch(/^[0-9a-f]{16}$/);
    const shape = row.answerShape as Record<string, unknown>;
    expect(shape).toMatchObject({ v: 1 });
    expect(typeof shape.chars).toBe('number');
    expect(JSON.stringify(shape)).not.toContain('Vexacorp');
  });
});
