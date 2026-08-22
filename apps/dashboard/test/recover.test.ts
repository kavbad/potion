// Stale-session recovery (lib/recover.ts + the lib/api.ts predicates it turns
// on). The bug these cover: middleware.ts checks cookie PRESENCE only, so an
// expired/revoked/reset-database cookie renders the page, the page calls the
// API, and the 401 came back as a 500. The recovery must fire on exactly that
// case, must not fire on a 403, and must not be able to loop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  path: '/usage' as string | null,
  search: '',
  cookie: 'stale-cookie' as string | null,
}));

vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (k: string) =>
      k === 'x-potion-path' ? state.path : k === 'x-potion-search' ? state.search : null,
  }),
  cookies: async () => ({
    get: () => (state.cookie === null ? undefined : { value: state.cookie }),
  }),
}));

// redirect() signals by throwing; the mock keeps that contract so the tests
// exercise the same control flow the pages rely on.
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

import { ApiError, ApiUnreachable, isForbidden, isSessionExpired } from '../lib/api';
import { fetchOrRecover } from '../lib/recover';

/** Where a thrown redirect points, or null if the call did not redirect. */
async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const m = /^REDIRECT (.*)$/.exec((e as Error).message);
    return m === null ? null : m[1]!;
  }
}

function respondWith(status: number, body: unknown = { error: { message: 'nope' } }): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  state.path = '/usage';
  state.search = '';
  state.cookie = 'stale-cookie';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('the predicates separate a dead session from a permission problem', () => {
  it('401 is a dead session; 403 is not', () => {
    expect(isSessionExpired(new ApiError(401, 'authentication required'))).toBe(true);
    expect(isSessionExpired(new ApiError(403, 'insufficient_role'))).toBe(false);
    expect(isForbidden(new ApiError(403, 'insufficient_role'))).toBe(true);
    expect(isForbidden(new ApiError(401, 'authentication required'))).toBe(false);
  });

  it('neither fires on non-API errors', () => {
    expect(isSessionExpired(new ApiUnreachable('http://localhost:3000'))).toBe(false);
    expect(isSessionExpired(new Error('boom'))).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });
});

describe('fetchOrRecover', () => {
  it('returns the body when the API is happy', async () => {
    respondWith(200, { ok: true });
    await expect(fetchOrRecover<{ ok: boolean }>('/api/usage')).resolves.toEqual({ ok: true });
  });

  it('sends a 401 to /api/auth/clear pointed back at the page it happened on', async () => {
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe(
      `/api/auth/clear?to=${encodeURIComponent('/usage')}`,
    );
  });

  it('carries the query string, so a date range survives signing back in', async () => {
    state.search = '?from=2026-01-01&to=2026-01-31';
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe(
      `/api/auth/clear?to=${encodeURIComponent('/usage?from=2026-01-01&to=2026-01-31')}`,
    );
  });

  it('strips the loop guard from the destination it hands back', async () => {
    // `cleared` present but not '1' — still a return trip, not a loop.
    state.search = '?cleared=0&from=2026-01-01';
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe(
      `/api/auth/clear?to=${encodeURIComponent('/usage?from=2026-01-01')}`,
    );
  });

  it('does NOT bounce a 403 through the clear route — that would sign out a valid session', async () => {
    respondWith(403);
    await expect(fetchOrRecover('/api/audit')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    });
  });

  it('leaves an unreachable API to the page, which has its own empty state', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchOrRecover('/api/usage')).rejects.toBeInstanceOf(ApiUnreachable);
  });

  it('passes a 500 through unchanged', async () => {
    respondWith(500);
    await expect(fetchOrRecover('/api/usage')).rejects.toMatchObject({ status: 500 });
  });
});

describe('the loop guards', () => {
  it('goes to /login instead of clearing again once cleared=1 is set', async () => {
    state.search = '?cleared=1';
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe('/login');
  });

  it('goes to /login when there is no cookie left to clear', async () => {
    state.cookie = null;
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe('/login');
  });
});

describe('the destination is never anything but a same-origin path', () => {
  it('falls back to / when middleware stamped no path', async () => {
    state.path = null;
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe(
      `/api/auth/clear?to=${encodeURIComponent('/')}`,
    );
  });

  it('refuses a protocol-relative path', async () => {
    state.path = '//evil.example/phish';
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe(
      `/api/auth/clear?to=${encodeURIComponent('/')}`,
    );
  });

  it('refuses an absolute URL', async () => {
    state.path = 'https://evil.example/phish';
    respondWith(401);
    expect(await redirectOf(() => fetchOrRecover('/api/usage'))).toBe(
      `/api/auth/clear?to=${encodeURIComponent('/')}`,
    );
  });
});
