// Tests for SPEC §12.1 provider resilience: error taxonomy, retry/backoff,
// circuit breaker transitions, hedging, failover chains, chaos provider, and
// the zero-key-material invariant.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  breakerStates,
  chaosProvider,
  classifyError,
  failoverChain,
  isRetryableKind,
  kindFromHttpStatus,
  resetBreakers,
  resilient,
  type CompleteRequest,
  type CompleteResponse,
  type Provider,
} from './index.js';

const REQ: CompleteRequest = {
  model: 'mock-cheap',
  messages: [{ role: 'user', content: 'hello' }],
  params: { seed: 42 },
};

function resp(text: string): CompleteResponse {
  return {
    text,
    usage: { inputTokens: 1, outputTokens: 2 },
    latencyMs: 5,
    modelVersion: 'mock-cheap-v1#mock-v1',
  };
}

/** Wrap a provider with a call counter. */
function counting(p: Provider): { provider: Provider; calls: () => number } {
  let n = 0;
  return {
    provider: {
      id: p.id,
      complete: async (req: CompleteRequest) => {
        n++;
        return p.complete(req);
      },
    },
    calls: () => n,
  };
}

beforeEach(() => resetBreakers());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
describe('error classification (SPEC §12.1 taxonomy)', () => {
  it('classifies HTTP statuses: 4xx → client_4xx (non-retryable)', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(kindFromHttpStatus(status)).toBe('client_4xx');
      const err = new ProviderError('mock', 'x', { status });
      expect(err.kind).toBe('client_4xx');
      expect(err.retryable).toBe(false);
    }
  });

  it('classifies 429 → rate_limit (retryable)', () => {
    expect(kindFromHttpStatus(429)).toBe('rate_limit');
    const err = new ProviderError('mock', 'x', { status: 429 });
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
  });

  it('classifies 5xx → server_5xx (retryable)', () => {
    for (const status of [500, 502, 503]) {
      expect(kindFromHttpStatus(status)).toBe('server_5xx');
      expect(new ProviderError('mock', 'x', { status }).retryable).toBe(true);
    }
  });

  it('classifies fetch TypeError and ENOTFOUND → network (retryable)', () => {
    expect(classifyError(new TypeError('fetch failed'))).toBe('network');
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND example.test'), {
      code: 'ENOTFOUND',
    });
    expect(classifyError(enotfound)).toBe('network');
    expect(isRetryableKind('network')).toBe(true);
  });

  it('classifies AbortError / TimeoutError → timeout (retryable)', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(classifyError(abort)).toBe('timeout');
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(classifyError(timeout)).toBe('timeout');
    expect(isRetryableKind('timeout')).toBe(true);
  });

  it('classifies anything else → unknown (non-retryable)', () => {
    expect(classifyError(new Error('weird'))).toBe('unknown');
    expect(classifyError('string throw')).toBe('unknown');
    expect(isRetryableKind('unknown')).toBe(false);
  });

  it('retryable set is exactly rate_limit | timeout | server_5xx | network', () => {
    expect(isRetryableKind('rate_limit')).toBe(true);
    expect(isRetryableKind('timeout')).toBe(true);
    expect(isRetryableKind('server_5xx')).toBe(true);
    expect(isRetryableKind('network')).toBe(true);
    expect(isRetryableKind('client_4xx')).toBe(false);
    expect(isRetryableKind('unknown')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('resilient() retry', () => {
  it('retries then succeeds: chaos seed 8 fails 2× then succeeds (failRate 0.5)', async () => {
    const { provider, calls } = counting(chaosProvider({ failRate: 0.5, seed: 8 }));
    const p = resilient(provider, {
      retries: 3,
      backoff: { baseMs: 1, maxMs: 2, jitter: 'none' },
    });
    const res = await p.complete(REQ);
    expect(res.text).toContain('[mock:mock-cheap]');
    expect(calls()).toBe(3); // initial attempt + 2 retries
  });

  it('retry-exhausted → typed ProviderError with kind/retryable', async () => {
    const { provider, calls } = counting(
      chaosProvider({ failRate: 1, kinds: ['server_5xx'], seed: 1 }),
    );
    const p = resilient(provider, {
      retries: 2,
      backoff: { baseMs: 1, maxMs: 2, jitter: 'none' },
    });
    const err = await p.complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    const pErr = err as ProviderError;
    expect(pErr.kind).toBe('server_5xx');
    expect(pErr.retryable).toBe(true);
    expect(pErr.status).toBe(500);
    expect(pErr.provider).toBe('mock');
    expect(pErr.model).toBe('mock-cheap');
    expect(calls()).toBe(3); // 1 + 2 retries
  });

  it('never retries client_4xx', async () => {
    const { provider, calls } = counting(
      chaosProvider({ failRate: 1, kinds: ['client_4xx'], seed: 1 }),
    );
    const p = resilient(provider, { retries: 3 });
    const err = await p.complete(REQ).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('client_4xx');
    expect((err as ProviderError).retryable).toBe(false);
    expect(calls()).toBe(1);
  });

  it('per-attempt timeout converts a hanging call into a retryable timeout error', async () => {
    const { provider, calls } = counting(chaosProvider({ failRate: 0, hangMs: 5_000, seed: 1 }));
    const p = resilient(provider, {
      retries: 1,
      timeoutMs: 30,
      backoff: { baseMs: 1, maxMs: 2, jitter: 'none' },
    });
    const err = await p.complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('timeout');
    expect((err as ProviderError).retryable).toBe(true);
    expect(calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('circuit breaker', () => {
  const POLICY = {
    retries: 0,
    breaker: { failureThreshold: 2, cooldownMs: 1_000, halfOpenProbes: 2 },
  };

  function makeStub(): { provider: Provider; setMode: (m: 'fail' | 'ok') => void; calls: () => number } {
    let mode: 'fail' | 'ok' = 'fail';
    let n = 0;
    return {
      provider: {
        id: 'mock',
        complete: async () => {
          n++;
          if (mode === 'fail') {
            throw new ProviderError('mock', 'boom', { kind: 'server_5xx', status: 500 });
          }
          return resp('ok');
        },
      },
      setMode: (m) => {
        mode = m;
      },
      calls: () => n,
    };
  }

  it('opens after threshold, fast-rejects while open, half-opens after cooldown, closes after probes', async () => {
    vi.useFakeTimers();
    const { provider, setMode, calls } = makeStub();
    const p = resilient(provider, POLICY);
    const key = 'mock:mock-cheap';
    expect(breakerStates()).toEqual({});

    // two consecutive failures → open
    await expect(p.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
    expect(breakerStates()[key]).toBe('closed');
    await expect(p.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
    expect(breakerStates()[key]).toBe('open');
    expect(calls()).toBe(2);

    // while open: rejects fast WITHOUT calling the provider
    const err = await p.complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).breakerOpen).toBe(true);
    expect(calls()).toBe(2);
    expect(breakerStates()[key]).toBe('open');

    // after cooldown: half-open probe succeeds → still half-open (needs 2)
    vi.advanceTimersByTime(1_001);
    setMode('ok');
    await expect(p.complete(REQ)).resolves.toMatchObject({ text: 'ok' });
    expect(breakerStates()[key]).toBe('half-open');

    // second probe success → closed
    await expect(p.complete(REQ)).resolves.toMatchObject({ text: 'ok' });
    expect(breakerStates()[key]).toBe('closed');
  });

  it('a failed half-open probe re-opens the breaker', async () => {
    vi.useFakeTimers();
    const { provider, setMode } = makeStub();
    const p = resilient(provider, POLICY);
    const key = 'mock:mock-cheap';

    await expect(p.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
    await expect(p.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
    expect(breakerStates()[key]).toBe('open');

    vi.advanceTimersByTime(1_001);
    // probe fails (mode still 'fail') → back to open, fresh cooldown
    await expect(p.complete(REQ)).rejects.toBeInstanceOf(ProviderError);
    expect(breakerStates()[key]).toBe('open');

    // fast-reject again until the NEW cooldown elapses
    vi.advanceTimersByTime(500);
    const err = await p.complete(REQ).catch((e: unknown) => e);
    expect((err as ProviderError).breakerOpen).toBe(true);

    vi.advanceTimersByTime(501);
    setMode('ok');
    await expect(p.complete(REQ)).resolves.toMatchObject({ text: 'ok' });
    expect(breakerStates()[key]).toBe('half-open');
  });
});

// ---------------------------------------------------------------------------
describe('hedging', () => {
  it('slow primary + fast duplicate → duplicate wins, loser aborted, usage counted once', async () => {
    let n = 0;
    let primaryAborted = false;
    const stub: Provider = {
      id: 'mock',
      complete: (req) => {
        n++;
        if (n === 1) {
          // slow primary: resolves after 300ms unless aborted
          return new Promise<CompleteResponse>((resolve, reject) => {
            const timer = setTimeout(() => resolve(resp('slow-primary')), 300);
            req.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                primaryAborted = true;
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
              },
              { once: true },
            );
          });
        }
        // fast duplicate
        return new Promise<CompleteResponse>((resolve) =>
          setTimeout(
            () =>
              resolve({
                text: 'fast-duplicate',
                usage: { inputTokens: 11, outputTokens: 22 },
                latencyMs: 10,
                modelVersion: 'mock-cheap-v1#mock-v1',
              }),
            10,
          ),
        );
      },
    };
    const p = resilient(stub, { retries: 0, hedgeAfterMs: 30, timeoutMs: 2_000 });
    const res = await p.complete(REQ);
    expect(res.text).toBe('fast-duplicate');
    expect(res.hedged).toBe(true);
    // winner's usage only — counted exactly once
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
    // give the aborted primary a tick to observe the AbortError
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(primaryAborted).toBe(true);
    expect(n).toBe(2);
  });

  it('fast primary → no duplicate is started and no hedged flag', async () => {
    let n = 0;
    const stub: Provider = {
      id: 'mock',
      complete: async () => {
        n++;
        return resp('primary');
      },
    };
    const p = resilient(stub, { retries: 0, hedgeAfterMs: 50, timeoutMs: 2_000 });
    const res = await p.complete(REQ);
    expect(res.text).toBe('primary');
    expect(res.hedged).toBeUndefined();
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('failoverChain', () => {
  it('first healthy provider wins; second is never called', async () => {
    const a = counting(chaosProvider({ failRate: 0, seed: 1 }));
    const b = counting(chaosProvider({ failRate: 0, seed: 2 }));
    const chain = failoverChain([a.provider, b.provider], { retries: 0 });
    const res = await chain.complete(REQ);
    expect(res.text).toContain('[mock:mock-cheap]');
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0);
  });

  it('first broken (retryable-exhausted) → second serves', async () => {
    const a = counting(chaosProvider({ failRate: 1, kinds: ['server_5xx'], seed: 1 }));
    const b = counting(chaosProvider({ failRate: 0, seed: 2 }));
    const chain = failoverChain([a.provider, b.provider], {
      retries: 1,
      backoff: { baseMs: 1, maxMs: 2, jitter: 'none' },
    });
    const res = await chain.complete(REQ);
    expect(res.text).toContain('[mock:mock-cheap]');
    expect(a.calls()).toBe(2); // 1 + 1 retry
    expect(b.calls()).toBe(1);
  });

  it('first breaker-open → second serves', async () => {
    vi.useFakeTimers();
    const a = counting(chaosProvider({ failRate: 1, kinds: ['server_5xx'], seed: 1 }));
    // Distinct provider id: breakers key on `${providerId}:${model}`.
    const b = counting({ id: 'openai', complete: async () => resp('b-ok') });
    const policy = {
      retries: 0,
      breaker: { failureThreshold: 1, cooldownMs: 60_000, halfOpenProbes: 1 },
    };
    const chain = failoverChain([a.provider, b.provider], policy);
    // first call: a fails once → breaker opens; b serves
    await expect(chain.complete(REQ)).resolves.toBeTruthy();
    expect(b.calls()).toBe(1);
    // second call: a fast-rejects (breaker open, no call), b serves again
    await expect(chain.complete(REQ)).resolves.toBeTruthy();
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(2);
  });

  it('non-retryable error propagates immediately (no failover)', async () => {
    const a = counting(chaosProvider({ failRate: 1, kinds: ['client_4xx'], seed: 1 }));
    const b = counting(chaosProvider({ failRate: 0, seed: 2 }));
    const chain = failoverChain([a.provider, b.provider], { retries: 2 });
    const err = await chain.complete(REQ).catch((e: unknown) => e);
    expect((err as ProviderError).kind).toBe('client_4xx');
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(0);
  });

  it('throws the last error when every provider fails', async () => {
    const chain = failoverChain(
      [
        chaosProvider({ failRate: 1, kinds: ['server_5xx'], seed: 1 }),
        chaosProvider({ failRate: 1, kinds: ['rate_limit'], seed: 2 }),
      ],
      { retries: 0 },
    );
    const err = await chain.complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('rate_limit'); // second provider's error
  });
});

// ---------------------------------------------------------------------------
describe('chaosProvider', () => {
  it('is deterministic: same seed → same failure sequence', async () => {
    const seq = async (seed: number): Promise<string> => {
      const p = chaosProvider({ failRate: 0.5, seed });
      const out: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await p.complete(REQ).then(
          () => 'ok',
          (e: unknown) => (e as ProviderError).kind,
        );
        out.push(r);
      }
      return out.join(',');
    };
    expect(await seq(7)).toBe(await seq(7));
    expect(await seq(7)).not.toBe(await seq(8)); // different seed → different stream
  });

  it('has id mock and $0-style mock usage shape', async () => {
    const p = chaosProvider({ failRate: 0, seed: 1 });
    expect(p.id).toBe('mock');
    const res = await p.complete(REQ);
    expect(res.text).toContain('[mock:mock-cheap]');
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('zero key material in errors', () => {
  const SECRET = 'sk-live-secret-abcdef123456';

  it('resilient() never leaks underlying error text that echoes headers/keys', async () => {
    const leaky: Provider = {
      id: 'openai',
      complete: async () => {
        throw new Error(`request failed; sent headers: authorization: Bearer ${SECRET}`);
      },
    };
    const p = resilient(leaky, { retries: 1, backoff: { baseMs: 1, maxMs: 2, jitter: 'none' } });
    const err = await p.complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).not.toContain(SECRET);
    expect((err as ProviderError).message).not.toContain('authorization');
    expect((err as ProviderError).kind).toBe('unknown');
  });

  it('failoverChain() never leaks key material either', async () => {
    const leaky: Provider = {
      id: 'openai',
      complete: async () => {
        throw new Error(`echo x-api-key: ${SECRET}`);
      },
    };
    const chain = failoverChain([leaky], { retries: 0 });
    const err = await chain.complete(REQ).catch((e: unknown) => e);
    expect((err as ProviderError).message).not.toContain(SECRET);
  });
});

// ---- P0-1 (external review, 2026-09-05): embed had no resilience ----
//
// `embed` passed through this wrapper untouched — no retry, no per-attempt
// timeout, no F19 breaker — on the reasoning that §12.1 defines retry for
// complete() and that the mock must stay deterministic. The second half does
// not follow from the first: a timeout and a bounded retry change WHEN a call
// gives up, not WHAT a mock returns. And the embedder is the hardest
// dependency on the serve path: every classified request waits on it.
describe('P0-1: embed is wrapped like everything else', () => {
  const texts = ['hello'];
  function embedder(impl: (n: number) => Promise<number[][]>): Provider {
    let calls = 0;
    return {
      id: 'openai',
      complete: async () => { throw new Error('not used'); },
      embed: async () => impl(++calls),
    };
  }

  it('RETRIES a retryable embed failure instead of surfacing the first one', async () => {
    const p = resilient(
      embedder(async (n) => {
        if (n < 3) throw new ProviderError('openai', 'flaky', { kind: 'server_5xx' });
        return [[1, 2, 3]];
      }),
      { retries: 3, backoff: { baseMs: 1, maxMs: 2, jitter: 'none' } },
    );
    expect(await p.embed!(texts)).toEqual([[1, 2, 3]]);
  });

  it('does NOT retry a client error — that is evidence about the caller', async () => {
    let calls = 0;
    const p = resilient(
      embedder(async (n) => { calls = n; throw new ProviderError('openai', 'bad input', { kind: 'client_4xx' }); }),
      { retries: 3, backoff: { baseMs: 1, maxMs: 2, jitter: 'none' } },
    );
    await expect(p.embed!(texts)).rejects.toThrow('bad input');
    expect(calls).toBe(1);
  });

  it('ABORTS a hung embedder at the declared timeout instead of hanging the request', async () => {
    const p = resilient(
      embedder(() => new Promise(() => { /* never settles */ })),
      { retries: 0, timeoutMs: 40 },
    );
    const started = Date.now();
    await expect(p.embed!(texts)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a deterministic embedder is returned unchanged — the mock concern was about output, not timing', async () => {
    const p = resilient(embedder(async () => [[0.5, 0.5]]));
    expect(await p.embed!(texts)).toEqual([[0.5, 0.5]]);
    expect(await p.embed!(texts)).toEqual([[0.5, 0.5]]);
  });
});
