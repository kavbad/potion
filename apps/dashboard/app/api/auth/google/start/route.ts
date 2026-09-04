// GET /api/auth/google/start — step one of Sign in with Google.
//
// This handler exists on the DASHBOARD, not the API server, for one reason:
// the cookie. Production serves the browser from withpotion.com and the API
// from api.withpotion.com (deploy/Caddyfile), so a flow cookie — and later a
// session cookie — set by the API server is a cookie this origin can never
// read. The same split the magic link already uses: the server owns the
// credential half, the dashboard owns the browser half.
//
// Nothing security-bearing is decided here. The state, nonce and PKCE
// verifier are minted and SIGNED by the server (POST /auth/google/begin,
// HMAC keyed on the Google client secret), and this handler only carries the
// resulting opaque value in an httpOnly cookie and follows the redirect it
// was handed. A tampered cookie fails the server's HMAC check at the
// callback; it cannot be forged here or in the browser.
import { NextResponse } from 'next/server';
import { publicOrigin } from '@/lib/origin';
import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface BeginResponse {
  authorizeUrl?: string;
  cookieName?: string;
  flow?: string;
  maxAgeSeconds?: number;
}

export async function GET(req: Request): Promise<NextResponse> {
  const origin = publicOrigin(req);
  const bounce = (error: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, origin));

  let body: BeginResponse | null;
  try {
    const res = await fetch(`${apiUrl()}/auth/google/begin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    // 404 is the configured-off case, not a fault: the routes are never
    // registered without POTION_GOOGLE_CLIENT_ID/SECRET. Say so plainly
    // rather than reporting a broken server.
    if (res.status === 404) return bounce('Google sign-in is not configured on this deployment');
    if (!res.ok) return bounce(`could not start Google sign-in (HTTP ${res.status})`);
    body = (await res.json().catch(() => null)) as BeginResponse | null;
  } catch {
    return bounce('the Potion API is unreachable — try the email link');
  }
  if (!body?.authorizeUrl || !body.flow || !body.cookieName) {
    return bounce('could not start Google sign-in');
  }

  const out = NextResponse.redirect(body.authorizeUrl);
  out.cookies.set(body.cookieName, body.flow, {
    httpOnly: true,
    // Lax, not Strict: Google's redirect back is a top-level cross-site
    // GET navigation, and Strict would withhold the cookie exactly then —
    // the flow would fail its state check every single time.
    sameSite: 'lax',
    secure: origin.startsWith('https://'),
    path: '/',
    maxAge: body.maxAgeSeconds ?? 600,
  });
  return out;
}
