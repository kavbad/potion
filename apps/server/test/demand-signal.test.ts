// THE DEMAND SIGNAL (SERVING-ROADMAP S7 / G9, leg L1) — migration 0041.
//
// Serving classified every request and threw the classification's own
// evidence away. `pickBest` scores EVERY centroid; the serve path kept the
// winner's id and dropped the confidence, the runner-up and the margin — the
// only numbers in the system that could say "this request fit nothing we
// have measured".
//
// Three properties are worth pinning, and only one of them is "the columns
// are populated":
//
//   1. It is FREE. If taking the signal cost a second embedding call on the
//      serve path, it would be a latency tax on every request and the right
//      answer would be not to take it. It must ride the embedding that
//      already happens.
//   2. It survives the CACHE. The assignment cache exists because prompts
//      repeat — and repetition is precisely what makes a demand cell. A
//      signal recorded only on cache misses would systematically under-count
//      the most common workloads, which is the opposite of the goal.
//   3. It is CONTENT-FREE. `shape` is what S7's cross-org aggregation reads,
//      so if message text can reach it, the aggregation design above it is
//      void.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let apiKey: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['POTION_SELF_SERVE', 'POTION_MAGIC_LINK_IN_RESPONSE', 'POTION_DEV_AUTH']) {
    saved[k] = process.env[k];
  }
  process.env.POTION_SELF_SERVE = '1';
  process.env.POTION_MAGIC_LINK_IN_RESPONSE = '1';
  process.env.POTION_DEV_AUTH = '0';
  app = await buildServer({ seed: false, platformBaseline: true });

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'content-type': 'application/json' },
    payload: { email: 'demand@startup.test' },
  });
  const token = new URL(signup.json().devLink as string).searchParams.get('token')!;
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/verify?token=${encodeURIComponent(token)}`,
  });
  const cookie = String(verify.headers['set-cookie'] ?? '').split(';')[0]!;
  const created = await app.inject({
    method: 'POST',
    url: '/api/policies',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { policy: { type: 'min_cost', qualityFloor: 0.8 }, createKey: true },
  });
  apiKey = created.json().apiKey as string;
}, 120_000);

afterAll(async () => {
  await app?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface SignalRow {
  status: string;
  cluster_id: string | null;
  cluster_confidence: number | null;
  runner_up_cluster: string | null;
  cluster_margin: number | null;
  shape: Record<string, unknown> | null;
}

async function rows(): Promise<SignalRow[]> {
  const res = await app.potion.db.db.execute(
    'select status, cluster_id, cluster_confidence, runner_up_cluster, cluster_margin, shape ' +
      'from request_logs order by id desc limit 50',
  );
  return (res.rows ?? []) as unknown as SignalRow[];
}

async function serve(payload: Record<string, unknown>): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: { model: 'potion-auto', ...payload },
  });
  return res.statusCode;
}

describe('a served request records how well it fit, and what it nearly was', () => {
  it('writes confidence, runner-up and margin beside the routing label', async () => {
    expect(
      await serve({
        messages: [
          { role: 'user', content: 'Write a Python function that merges two sorted lists.' },
        ],
      }),
    ).toBe(200);

    const row = (await rows()).find((r) => r.status === 'ok')!;
    expect(row, 'no served row was logged').toBeTruthy();
    expect(row.cluster_id).toBeTruthy();
    expect(Number(row.cluster_confidence)).toBeGreaterThan(0);
    // The runner-up is a DIFFERENT cluster than the one that served, and the
    // margin is the gap between them — non-negative, because the decision
    // came from the top of the same ranking.
    expect(row.runner_up_cluster).not.toBe(row.cluster_id);
    expect(row.runner_up_cluster).toBeTruthy();
    expect(Number(row.cluster_margin)).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('records the same signal on a CACHE HIT — repetition is the demand', async () => {
    // The assignment cache is keyed on content, so the second identical
    // prompt never reaches the assigner. Under the old shape (cache of
    // Assignment) there would have been nothing to record; the cache now
    // holds the ranking, so a repeat is as legible as a first.
    const prompt = 'Summarize this quarterly report into three bullet points.';
    expect(await serve({ messages: [{ role: 'user', content: prompt }] })).toBe(200);
    expect(await serve({ messages: [{ role: 'user', content: prompt }] })).toBe(200);

    const served = (await rows()).filter((r) => r.status === 'ok').slice(0, 2);
    expect(served).toHaveLength(2);
    for (const row of served) {
      expect(row.cluster_confidence).not.toBeNull();
    }
    // Identical prompt, identical classification — the cache did not change
    // the answer, only who computed it.
    expect(served[0]!.cluster_id).toBe(served[1]!.cluster_id);
    expect(Number(served[0]!.cluster_confidence)).toBeCloseTo(
      Number(served[1]!.cluster_confidence),
      12,
    );
  }, 60_000);

  it('records the request SHAPE, and nothing from the message content', async () => {
    const secret = 'ACME-INTERNAL-CODENAME-BLUEBIRD';
    expect(
      await serve({
        messages: [
          { role: 'system', content: `Follow ${secret} handling rules.` },
          { role: 'user', content: `Extract the invoice total from ${secret}.` },
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'lookup_customer_ssn', description: 'internal', parameters: {} },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'lookup_customer_ssn' } },
        max_tokens: 256,
      }),
    ).toBe(200);

    const row = (await rows()).find((r) => r.status === 'ok')!;
    expect(row.shape).toMatchObject({
      messages: 2,
      system: true,
      tools: 1,
      toolChoice: 'named',
      stream: false,
      maxTokens: 256,
      chars: '0-1k',
    });
    // Neither the customer's content nor their tool NAMES may land in the
    // field that S7 aggregates across orgs.
    const serialized = JSON.stringify(row.shape);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('lookup_customer_ssn');
  }, 60_000);

  it('leaves the signal NULL — never 0 — when nothing was classified', async () => {
    // A rejected key never reached the assigner. A backfilled 0 would read
    // as "nothing we serve fits this", which is the exact finding this
    // column exists to make; absence must stay absent.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer pk_not_a_real_key', 'content-type': 'application/json' },
      payload: { model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(bad.statusCode).toBe(401);
    const row = (await rows()).find((r) => r.status === 'auth_failed')!;
    expect(row).toBeTruthy();
    expect(row.cluster_confidence).toBeNull();
    expect(row.runner_up_cluster).toBeNull();
    expect(row.cluster_margin).toBeNull();
  }, 60_000);
});
