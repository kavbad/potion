// Retry/timeout wrapper tests (SPEC §2): stubbed global fetch via
// vi.stubGlobal, injected sleep/rand — ZERO network. Covers retry counts,
// backoff sequence, no-retry on 4xx, rate-limit exhaustion, and timeout abort.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  postJsonWithRetry,
  ProviderAuthError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OK_BODY = { ok: true };
const REQ = { url: 'https://api.test/v1/x', headers: {}, body: { ping: 1 } };

/** Sleep spy that records delays without actually waiting. */
function sleepRecorder(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('postJsonWithRetry', () => {
  it('succeeds on first 200 without any retry sleep', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY));
    const { sleep, delays } = sleepRecorder();
    const res = await postJsonWithRetry<typeof OK_BODY>('openai', REQ, { sleep, rand: () => 0.5 });
    expect(res.status).toBe(200);
    expect(res.json).toEqual(OK_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries 429 → 500 → 200 with exact 250/500 backoff (jitter zeroed)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'slow down' } }))
      .mockResolvedValueOnce(jsonResponse(500, { error: { message: 'boom' } }))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const { sleep, delays } = sleepRecorder();
    const res = await postJsonWithRetry('openai', REQ, { sleep, rand: () => 0.5 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([250, 500]); // base ×2 with ±0% jitter at rand=0.5
  });

  it('exhausts retries on persistent 429 → ProviderRateLimitError (4 attempts, 3 sleeps)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'rate limited' } }));
    const { sleep, delays } = sleepRecorder();
    const err = await postJsonWithRetry('anthropic', REQ, { sleep, rand: () => 0.5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderRateLimitError).retryAttempts).toBe(4);
    expect((err as Error).message).toMatch(/rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 + maxRetries(3)
    expect(delays).toEqual([250, 500, 1000]);
  });

  it('exhausts retries on persistent 5xx → ProviderError with status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const { sleep } = sleepRecorder();
    const err = await postJsonWithRetry('google', REQ, { sleep, rand: () => 0.5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderRateLimitError);
    expect((err as ProviderError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('NEVER retries 400: one call, no sleep, plain ProviderError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: { message: 'bad request' } }));
    const { sleep, delays } = sleepRecorder();
    const err = await postJsonWithRetry('openai', REQ, { sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/bad request/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('401 → ProviderAuthError immediately, never retried', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'invalid key' } }));
    const { sleep } = sleepRecorder();
    const err = await postJsonWithRetry('openai', REQ, { sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect((err as ProviderError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('403 → ProviderAuthError immediately', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { message: 'forbidden' } }));
    const { sleep } = sleepRecorder();
    const err = await postJsonWithRetry('openrouter', REQ, { sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries network errors (fetch reject) then succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const { sleep, delays } = sleepRecorder();
    const res = await postJsonWithRetry('openai', REQ, { sleep, rand: () => 0.5 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([250]);
  });

  it('network error on every attempt → ProviderError after exhaustion', async () => {
    fetchMock.mockRejectedValue(new TypeError('socket hang up'));
    const { sleep } = sleepRecorder();
    const err = await postJsonWithRetry('openai', REQ, { sleep, rand: () => 0.5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/network error/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries a 200 whose body fails JSON parsing, then succeeds on a clean body', async () => {
    // Live capture 2026-08-20: an OpenRouter gemini-2.5-pro 200 carried a raw
    // control character, which strict JSON parsing rejects. Previously this
    // returned json=undefined and callers threw an untyped TypeError.
    const corrupt = new Response('{"choices":[{"message":{"content":"a\u0001b', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    fetchMock.mockResolvedValueOnce(corrupt).mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    const { sleep, delays } = sleepRecorder();
    const res = await postJsonWithRetry('openrouter', REQ, { sleep, rand: () => 0.5 });
    expect(res.status).toBe(200);
    expect(res.json).toEqual(OK_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([250]);
  });

  it('unparseable 200 body on every attempt → typed ProviderError, never undefined json', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response('not json at all', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const { sleep } = sleepRecorder();
    const err = await postJsonWithRetry('openrouter', REQ, { sleep, rand: () => 0.5 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/body failed JSON parsing/);
    expect((err as ProviderError).kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('honors a custom maxRetries (0 → exactly one attempt)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const { sleep, delays } = sleepRecorder();
    const err = await postJsonWithRetry('openai', REQ, { sleep, maxRetries: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('aborts a hung request at timeoutMs → ProviderTimeoutError, no retry', async () => {
    // Stub fetch that hangs until the AbortController fires.
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );
    const { sleep, delays } = sleepRecorder();
    const err = await postJsonWithRetry('openai', REQ, { sleep, timeoutMs: 30 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderTimeoutError);
    expect((err as ProviderTimeoutError).timeoutMs).toBe(30);
    expect((err as Error).message).toMatch(/timed out after 30ms/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // timeouts are not retried
    expect(delays).toEqual([]);
  });
});

describe('backoffDelayMs', () => {
  it('is base×2^(n-1) with zero jitter at rand=0.5', () => {
    expect(backoffDelayMs(1, 250, 0.2, () => 0.5)).toBe(250);
    expect(backoffDelayMs(2, 250, 0.2, () => 0.5)).toBe(500);
    expect(backoffDelayMs(3, 250, 0.2, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(4, 250, 0.2, () => 0.5)).toBe(2000);
  });

  it('stays within ±20% jitter bounds', () => {
    for (let i = 0; i < 200; i++) {
      const d = backoffDelayMs(2); // exponential = 500
      expect(d).toBeGreaterThanOrEqual(400); // 500 × 0.8
      expect(d).toBeLessThanOrEqual(600); // 500 × 1.2
    }
  });
});
