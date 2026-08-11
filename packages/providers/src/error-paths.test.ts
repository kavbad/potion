// F19 — provider ERROR paths, driven through the providers PRODUCTION builds.
//
// The driver audit's cross-cutting finding is that the error branches written
// for production are reachable almost nowhere: the mock never throws, so every
// hermetic test runs a happy path. The one breaker test that existed
// (tests/chaos/breaker-exhaustion) hand-wraps a provider with an explicit
// policy — which is exactly what production did NOT do.
//
// So these drive `createProviders()`' own output over a stubbed-but-realistic
// HTTP transport: real status codes, real response bodies, real retry ladder,
// real breaker. The only thing swapped is the socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceTable } from '@potion/core';
import { createProviders, type CompleteRequest } from './index.js';
import { breakerStates, resetBreakers } from './resilience.js';
import { breakerPolicyFromEnv } from './factory.js';
import { DEFAULT_BREAKER } from './resilience.js';

const PRICES: PriceTable = {
  version: '2026-08-04',
  updatedAt: '2026-08-04',
  entries: [
    { alias: 'gpt-mini-class', provider: 'openai', model: 'gpt-4.1-mini-2025-04-14', inputPer1M: 0.4, outputPer1M: 1.6 },
  ],
};
const KEYS = { openai: 'sk-oai' } as const;
const REQ: CompleteRequest = {
  model: 'gpt-mini-class',
  messages: [{ role: 'user', content: 'Say OK' }],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetBreakers();
  // Threshold 2 keeps the retry ladder short; the DEFAULT is 5 and is
  // asserted separately below.
  vi.stubEnv('POTION_BREAKER_THRESHOLD', '2');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetBreakers();
});

/** The factory as production builds it, minus the transport's own retry loop
 * (maxRetries: 0) so the ladder under test is `resilient()`'s, not http.ts's.
 * Both exist; isolating one is what makes the assertions legible. */
function factoryProviders() {
  return createProviders({ prices: PRICES, apiKeys: { ...KEYS }, maxRetries: 0, timeoutMs: 2_000 });
}

async function attempt(): Promise<unknown> {
  return factoryProviders().openai.complete(REQ).then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe('F19: the breaker production actually runs', () => {
  it('is wired by default, and POTION_BREAKER=off is a real escape hatch', () => {
    vi.unstubAllEnvs();
    expect(breakerPolicyFromEnv({})).toEqual(DEFAULT_BREAKER);
    expect(breakerPolicyFromEnv({ POTION_BREAKER: 'off' })).toBeUndefined();
    expect(breakerPolicyFromEnv({ POTION_BREAKER: '0' })).toBeUndefined();
    expect(breakerPolicyFromEnv({ POTION_BREAKER_THRESHOLD: '9' })?.failureThreshold).toBe(9);
    // A garbage value must not silently disable the protection.
    expect(breakerPolicyFromEnv({ POTION_BREAKER_THRESHOLD: 'nonsense' })?.failureThreshold).toBe(
      DEFAULT_BREAKER.failureThreshold,
    );
  });

  it('server_5xx: retried, counted, and the breaker OPENS — then fails fast', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'upstream boom' } }));

    const first = await attempt();
    expect((first as { kind?: string }).kind).toBe('server_5xx');
    const second = await attempt();
    expect(second).toBeDefined();

    // /readyz reads this map. Before F19 it was permanently {}.
    const states = breakerStates();
    const key = Object.keys(states).find((k) => k.startsWith('openai:'));
    expect(key, `no breaker record created; states=${JSON.stringify(states)}`).toBeDefined();
    expect(states[key!]).toBe('open');

    // The next call must not reach the network at all.
    const callsBefore = fetchMock.mock.calls.length;
    const fastRejected = await attempt();
    expect((fastRejected as { breakerOpen?: boolean }).breakerOpen).toBe(true);
    expect(fetchMock.mock.calls.length, 'an open breaker still called the provider').toBe(callsBefore);
  }, 60_000);

  it('rate_limit (429) also counts toward the breaker', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'slow down' } }));
    await attempt();
    await attempt();
    const states = breakerStates();
    expect(Object.values(states)).toContain('open');
  }, 60_000);

  it('AUTH (401) is NOT retried and does NOT trip the breaker', async () => {
    // The load-bearing exclusion. A bad or expired key is evidence about the
    // CALLER, not about provider health: counting it would let one tenant's
    // misconfiguration open the breaker for every other org on the platform.
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'invalid api key' } }));

    const err = await attempt();
    expect((err as { retryable?: boolean }).retryable).toBe(false);
    // One call — no retry ladder for a 4xx.
    expect(fetchMock.mock.calls.length).toBe(1);

    await attempt();
    await attempt();
    await attempt();
    const states = breakerStates();
    expect(
      Object.values(states).filter((s) => s === 'open'),
      'auth failures opened the breaker — one tenant can now take out the provider',
    ).toEqual([]);
  }, 60_000);

  it('recovers: cooldown → half-open probes → closed', async () => {
    vi.stubEnv('POTION_BREAKER_COOLDOWN_MS', '1');
    vi.stubEnv('POTION_BREAKER_PROBES', '1');
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { message: 'boom' } }));
    await attempt();
    await attempt();
    expect(Object.values(breakerStates())).toContain('open');

    // Provider comes back.
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        model: 'gpt-4.1-mini-2025-04-14',
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 20)); // cooldown elapses
    const res = await factoryProviders().openai.complete(REQ);
    expect(res.text).toContain('OK');
    expect(Object.values(breakerStates())).toContain('closed');
  }, 60_000);
});

describe('F19: the caller\'s cancellation reaches the socket', () => {
  it('an aborted CompleteRequest aborts the outbound fetch', async () => {
    // Before F19 the live transports made their own AbortController and threw
    // the caller's signal away, so an abandoned call kept running at the
    // provider — and kept being billed. Latent while hedging was off; it is
    // also the precondition for ever turning hedging on, because a hedge that
    // cannot cancel its loser is a duplicate purchase, not an optimization.
    const controller = new AbortController();
    let sawAbort = false;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        setTimeout(() => controller.abort(), 5);
      });
    });

    await factoryProviders()
      .openai.complete({ ...REQ, signal: controller.signal })
      .catch(() => undefined);

    expect(sawAbort, "the caller's abort never reached the transport").toBe(true);
  }, 60_000);
});
