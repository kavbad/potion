// THE BROWSER HALF OF SIGN IN WITH GOOGLE (2026-09-04).
//
// These two handlers hold no secrets and make no security decisions — the
// API server does all of that (apps/server/src/routes/google-auth.ts, and
// its test file pins the crypto). What lives HERE is the part that is
// invisible until it breaks in production:
//
//   · the flow cookie must be httpOnly and SameSite=Lax. Strict is the
//     trap: Google's redirect back is a top-level cross-site navigation,
//     so a Strict cookie is withheld exactly then and every sign-in dies
//     on the state check.
//   · the session cookie must be planted on THIS origin. That is the whole
//     reason this half is not on the API server, which answers on a
//     different host and whose cookies the dashboard cannot read.
//   · every refusal must land the visitor back on /login WITH a reason.
//     "Nothing happened" is the worst answer a sign-in can give.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as start } from '@/app/api/auth/google/start/route';
import { GET as callback } from '@/app/api/auth/google/callback/route';

const ORIGIN = 'https://withpotion.com';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=st';

function req(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie === undefined ? {} : { cookie } });
}

/** One scripted API response for the single fetch each handler makes. */
function stubApi(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
}

function setCookieOf(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POTION_APP_URL;
});

describe('GET /api/auth/google/start', () => {
  it('carries the server-minted flow in an httpOnly Lax cookie and follows Google', async () => {
    process.env.POTION_APP_URL = ORIGIN;
    stubApi(200, { authorizeUrl: AUTHORIZE, cookieName: 'potion_google', flow: 'payload.sig', maxAgeSeconds: 600 });
    const res = await start(req(`${ORIGIN}/api/auth/google/start`));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(AUTHORIZE);
    const cookie = setCookieOf(res, 'potion_google');
    expect(cookie).toBeDefined();
    expect(cookie).toContain('payload.sig');
    expect(cookie).toContain('HttpOnly');
    // Lax, never Strict — see the file header.
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=600');
  });

  it('a 404 from the API is the UNCONFIGURED case, said plainly — not a fault', async () => {
    process.env.POTION_APP_URL = ORIGIN;
    stubApi(404, {});
    const res = await start(req(`${ORIGIN}/api/auth/google/start`));
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/login?error=');
    expect(decodeURIComponent(location)).toContain('not configured');
  });

  it('an unreachable API sends the visitor back with the door that still works', async () => {
    process.env.POTION_APP_URL = ORIGIN;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await start(req(`${ORIGIN}/api/auth/google/start`));
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('email link');
  });
});

describe('GET /api/auth/google/callback', () => {
  const url = `${ORIGIN}/api/auth/google/callback?code=abc&state=st`;

  it('plants the session cookie ON THIS ORIGIN, clears the flow, and goes home', async () => {
    process.env.POTION_APP_URL = ORIGIN;
    stubApi(200, { token: 'ps_deadbeef', email: 'a@b.com' });
    const res = await callback(req(url, 'potion_google=payload.sig'));
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
    const session = setCookieOf(res, 'potion_session');
    expect(session).toContain('ps_deadbeef');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Max-Age=604800'); // 7 days, matching the server
    // The flow cookie is spent either way.
    expect(setCookieOf(res, 'potion_google')).toContain('Max-Age=0');
  });

  it('forwards code, state AND the held flow cookie to the API — all three', async () => {
    process.env.POTION_APP_URL = ORIGIN;
    const spy = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) =>
        new Response(JSON.stringify({ token: 'ps_x', init }), { status: 200 }),
    );
    vi.stubGlobal('fetch', spy);
    await callback(req(url, 'potion_google=payload.sig'));
    const sent = spy.mock.calls[0]?.[1];
    const body = JSON.parse(String(sent?.body)) as Record<string, string>;
    expect(body).toEqual({ code: 'abc', state: 'st', flow: 'payload.sig' });
  });

  it("Google's own access_denied is an ordinary cancellation, worded like one", async () => {
    process.env.POTION_APP_URL = ORIGIN;
    stubApi(200, {});
    const res = await callback(req(`${ORIGIN}/api/auth/google/callback?error=access_denied`));
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('cancelled');
  });

  it('a missing flow cookie is explained, not shrugged at', async () => {
    process.env.POTION_APP_URL = ORIGIN;
    stubApi(200, { token: 'ps_x' });
    const res = await callback(req(url));
    const reason = decodeURIComponent(res.headers.get('location') ?? '');
    expect(reason).toContain('/login?error=');
    expect(reason).toContain('too long');
  });

  it("a refusal from the API reaches the visitor in the API's own words", async () => {
    process.env.POTION_APP_URL = ORIGIN;
    stubApi(403, { error: { message: 'Google has not verified a@b.com' } });
    const res = await callback(req(url, 'potion_google=payload.sig'));
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('has not verified');
    expect(setCookieOf(res, 'potion_session')).toBeUndefined();
  });
});
