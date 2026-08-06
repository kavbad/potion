/**
 * @potion/sdk tests — vitest against a LOCAL mock HTTP server (no live calls).
 *
 * The mock server implements POST /v1/chat/completions with the Potion wire
 * contract: OpenAI-shaped JSON + x-frontier-trace header, and OpenAI-shaped
 * error bodies for the mapped codes. Mirrors sdks/python/tests/test_client.py.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  PolicyNotFoundError,
  Potion,
  PotionChatCompletion,
  PotionError,
  RateLimitExceededError,
} from '../src/index.js';

const TRACE =
  'cluster=code-gen;strategy=1a2b3c4d;frontier=v3;policy=min_cost;fallback=0;' +
  'provenance=mock;policy_override=quality-first';

const COMPLETION = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'potion-auto',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello back' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.00042 },
};

/** Capture of the last request for assertions. */
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastPath = '';

function errorPayload(message: string, type: string, code: string, param: string | null = null) {
  return { error: { message, type, param, code } };
}

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastHeaders = req.headers;
      lastPath = req.url ?? '';
      const policy = req.headers['x-potion-policy'];
      const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
        const data = JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...extra,
        });
        res.end(data);
      };
      if (policy === 'does-not-exist') {
        return send(
          400,
          errorPayload(
            "unknown policy 'does-not-exist' — no policy with that id or name exists in your org",
            'invalid_request_error',
            'policy_not_found',
            'X-Potion-Policy',
          ),
        );
      }
      if (policy === 'busted-budget') {
        return send(
          429,
          errorPayload('monthly budget cap reached', 'budget_exceeded', 'budget_exceeded'),
        );
      }
      if (policy === 'slow-down') {
        return send(
          429,
          errorPayload('rate limit exceeded', 'rate_limit_exceeded', 'rate_limit_exceeded'),
        );
      }
      if (policy === 'weird-failure') {
        return send(
          500,
          errorPayload('strategy execution failed: boom', 'service_unavailable', 'service_unavailable'),
        );
      }
      return send(200, COMPLETION, { 'x-frontier-trace': TRACE });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function makeClient(extra: Record<string, unknown> = {}): Potion {
  return new Potion({ baseUrl, apiKey: 'pk_test_mock', maxRetries: 0, ...extra });
}

async function create(client: Potion, policy?: string) {
  return (await client.chat.completions.create({
    model: 'potion-auto',
    messages: [{ role: 'user', content: 'hello' }],
    ...(policy !== undefined ? { policy } : {}),
  })) as PotionChatCompletion;
}

describe('header sent', () => {
  it('no policy anywhere sends no header', async () => {
    await create(makeClient());
    expect(lastHeaders['x-potion-policy']).toBeUndefined();
    expect(lastPath).toBe('/v1/chat/completions');
  });

  it('defaultPolicy sends header', async () => {
    await create(makeClient({ defaultPolicy: 'cheap' }));
    expect(lastHeaders['x-potion-policy']).toBe('cheap');
  });

  it('per-request policy sends header', async () => {
    await create(makeClient(), 'quality-first');
    expect(lastHeaders['x-potion-policy']).toBe('quality-first');
  });

  it('per-request policy wins over default', async () => {
    await create(makeClient({ defaultPolicy: 'cheap' }), 'quality-first');
    expect(lastHeaders['x-potion-policy']).toBe('quality-first');
  });

  it('defaultPolicy applies when request omits policy', async () => {
    await create(makeClient({ defaultPolicy: 'cheap' }));
    expect(lastHeaders['x-potion-policy']).toBe('cheap');
  });

  it('custom headers preserved alongside policy', async () => {
    await makeClient().chat.completions.create(
      {
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'hello' }],
        policy: 'p1',
      },
      { headers: { 'x-custom': 'yes' } },
    );
    expect(lastHeaders['x-potion-policy']).toBe('p1');
    expect(lastHeaders['x-custom']).toBe('yes');
  });
});

describe('response wrapper', () => {
  it('frontierTrace parsed', async () => {
    const resp = await create(makeClient());
    expect(resp.frontierTrace).not.toBeNull();
    expect(resp.frontierTrace?.get('cluster')).toBe('code-gen');
    expect(resp.frontierTrace?.strategy).toBe('1a2b3c4d');
    expect(resp.frontierTrace?.frontier).toBe('v3');
    expect(resp.frontierTrace?.policy).toBe('min_cost');
    expect(resp.frontierTrace?.provenance).toBe('mock');
    expect(resp.frontierTrace?.policyOverride).toBe('quality-first');
    expect(resp.frontierTrace?.upgraded).toBeUndefined();
  });

  it('cost from usage', async () => {
    const resp = await create(makeClient());
    expect(resp.cost).toBeCloseTo(0.00042);
  });

  it('openai fields exposed', async () => {
    const resp = await create(makeClient());
    expect(resp.id).toBe('chatcmpl-test');
    expect(resp.choices[0]?.message.content).toBe('hello back');
    expect(resp.usage?.total_tokens).toBe(5);
    expect(resp.toJSON().object).toBe('chat.completion');
  });

  it('null frontierTrace when header absent', async () => {
    const resp = new PotionChatCompletion(COMPLETION as never, new Headers());
    expect(resp.frontierTrace).toBeNull();
  });
});

describe('error mapping', () => {
  it('policy_not_found', async () => {
    const err = await create(makeClient(), 'does-not-exist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyNotFoundError);
    expect(err).toBeInstanceOf(PotionError);
    const e = err as PolicyNotFoundError;
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('policy_not_found');
    expect(e.param).toBe('X-Potion-Policy');
    expect(e.type).toBe('invalid_request_error');
  });

  it('budget_exceeded', async () => {
    const err = await create(makeClient(), 'busted-budget').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    const e = err as BudgetExceededError;
    expect(e.statusCode).toBe(429);
    expect(e.code).toBe('budget_exceeded');
  });

  it('rate_limit_exceeded', async () => {
    const err = await create(makeClient(), 'slow-down').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitExceededError);
    const e = err as RateLimitExceededError;
    expect(e.statusCode).toBe(429);
    expect(e.code).toBe('rate_limit_exceeded');
  });

  it('unmapped code falls back to PotionError', async () => {
    const err = await create(makeClient(), 'weird-failure').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PotionError);
    expect(err).not.toBeInstanceOf(PolicyNotFoundError);
    const e = err as PotionError;
    expect(e.code).toBe('service_unavailable');
    expect(e.statusCode).toBe(500);
  });
});
