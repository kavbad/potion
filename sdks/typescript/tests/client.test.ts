/**
 * @potion/sdk tests — vitest against a LOCAL mock HTTP server (no live calls).
 *
 * The mock server implements POST /v1/chat/completions with the Potion wire
 * contract: OpenAI-shaped JSON + x-frontier-trace header, and OpenAI-shaped
 * error bodies for the mapped codes. Mirrors sdks/python/tests/test_client.py.
 */

import { createServer, type Server } from 'node:http';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BudgetExceededError,
  PolicyNotFoundError,
  Potion,
  PotionChatCompletion,
  PotionError,
  type PotionRouting,
  RateLimitExceededError,
} from '../src/index.js';

const TRACE =
  'cluster=code-gen;strategy=1a2b3c4d;frontier=v3;policy=min_cost;fallback=0;' +
  'provenance=mock;policy_override=quality-first';

/**
 * The Potion wire shape: OpenAI's completion, plus the `cost` the server
 * reports on usage — the same extension src/client.ts reads off it.
 */
type PotionWireCompletion = Omit<ChatCompletion, 'usage'> & {
  usage?: ChatCompletion['usage'] & { cost?: number };
  /** The typed routing object the server attaches to every non-streaming answer. */
  potion?: PotionRouting;
};

// TYPED, not cast (2026-09-11). This fixture reached
// `new PotionChatCompletion(COMPLETION as never, ...)`, and `as never` means
// the fixture is checked against NOTHING. Annotating it — what the
// escape-hatch ratchet means by "fix the type instead" — immediately found
// three real defects it had been hiding: `refusal` and `logprobs` are
// required by the OpenAI types and were absent, and `cost` is not a field of
// CompletionUsage, so the fixture was only ever a valid POTION completion,
// never an OpenAI one. Both are now said out loud instead of cast away.
const COMPLETION: PotionWireCompletion = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'potion-auto',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello back', refusal: null },
      logprobs: null,
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.00042 },
  potion: {
    requested_cluster: 'auto',
    resolved_cluster: 'code-gen',
    requested_policy: 'quality-first',
    policy_source: 'override',
    resolved_policy_type: 'min_cost',
    model: 'mock-cheap',
    fallback: false,
    cost_usd: 0.00042,
    provenance: 'mock',
  },
};

/** Capture of the last request for assertions. */
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastPath = '';
let lastOutcomeBody: Record<string, unknown> | null = null;

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
      // G1 Outcome API (SPEC §16) — the wire contract client.outcome() speaks.
      if ((req.url ?? '').endsWith('/outcomes')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        lastOutcomeBody = body;
        if (body.request_id === 'chatcmpl-unknown') {
          return send(
            404,
            errorPayload(
              "no served request 'chatcmpl-unknown' for this org — outcomes attach to requests Potion served",
              'invalid_request_error',
              'unknown_request',
            ),
          );
        }
        return send(201, {
          id: 'oc-1',
          request_id: body.request_id,
          attached: { cluster: 'code-gen', strategy: '1a2b3c4d', router_version: 3 },
        });
      }
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
    const resp = new PotionChatCompletion(COMPLETION, new Headers());
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

describe('outcome (G1 Outcome API)', () => {
  it('POSTs /v1/outcomes with snake-cased signals and returns the receipt', async () => {
    const receipt = await makeClient().outcome('chatcmpl-test', {
      success: true,
      validator: 'tests_passed',
      failureReason: 'flaky suite',
    });
    expect(lastPath).toBe('/v1/outcomes');
    expect(lastOutcomeBody).toEqual({
      request_id: 'chatcmpl-test',
      success: true,
      validator: 'tests_passed',
      failure_reason: 'flaky suite',
    });
    expect(receipt.id).toBe('oc-1');
    expect(receipt.attached.cluster).toBe('code-gen');
    expect(receipt.attached.router_version).toBe(3);
  });

  it('maps an unknown request to a PotionError carrying the server message', async () => {
    const err = await makeClient()
      .outcome('chatcmpl-unknown', { success: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PotionError);
    const e = err as PotionError;
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe('unknown_request');
    expect(e.message).toContain('outcomes attach to requests Potion served');
  });
});

describe('typed routing on the response (2026-09-16)', () => {
  it('.routing exposes the top-level potion object verbatim; null when a backend sends none', () => {
    const headers = new Headers({ 'x-frontier-trace': TRACE });
    const withRouting = new PotionChatCompletion(COMPLETION, headers);
    expect(withRouting.routing).toEqual(COMPLETION.potion);
    expect(withRouting.routing?.fallback).toBe(false);
    expect(withRouting.routing?.resolved_cluster).toBe('code-gen');
    const { potion: _dropped, ...plain } = COMPLETION;
    const without = new PotionChatCompletion(plain, headers);
    expect(without.routing).toBeNull();
  });

  it('the trace exposes underpowered when the server stamps it', () => {
    const t = new PotionChatCompletion(COMPLETION, new Headers({ 'x-frontier-trace': `${TRACE};underpowered=2` })).frontierTrace;
    expect(t?.underpowered).toBe('2');
    expect(new PotionChatCompletion(COMPLETION, new Headers({ 'x-frontier-trace': TRACE })).frontierTrace?.underpowered).toBeUndefined();
  });
});
