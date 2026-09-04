// GET /api/auth/google/callback?code&state — step two of Sign in with Google.
//
// This is the URL registered in the Google Cloud console, and it is on the
// dashboard origin for the cookie reason spelled out in ../start/route.ts.
// The handler carries three values to the API server — the code and state
// Google returned, and the signed flow cookie this origin has been holding
// — and gets back either a session token or a refusal. Every check that
// matters (HMAC, expiry, exact state match, PKCE, RS256 signature, iss/aud/
// exp, nonce, email_verified) happens on the server, where the client
// secret and the JWKS live.
//
// A refusal is SAID, not swallowed: the visitor lands back on /login with
// the server's own message, because "nothing happened" is the worst
// possible answer to a sign-in attempt.
import { NextResponse } from 'next/server';
import { publicOrigin } from '@/lib/origin';
import { SESSION_COOKIE, apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // must match server SESSION_TTL_MS
const FLOW_COOKIE = 'potion_google'; // must match server GOOGLE_FLOW_COOKIE

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const origin = publicOrigin(req);
  const secure = origin.startsWith('https://');
  const clearFlow = (res: NextResponse) => {
    res.cookies.set(FLOW_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 0 });
    return res;
  };
  const bounce = (error: string) =>
    clearFlow(NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, origin)));

  // Google's own refusal (the visitor closed the chooser, or denied consent)
  // arrives as ?error= and is not a Potion failure. Say the ordinary thing.
  const googleError = url.searchParams.get('error');
  if (googleError === 'access_denied') return bounce('Google sign-in was cancelled');
  if (googleError) return bounce(`Google refused the sign-in (${googleError})`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // Next's cookies() is not needed here — the raw header is the request's
  // own, and reading it directly keeps this handler synchronous.
  const flow = readCookie(req.headers.get('cookie'), FLOW_COOKIE);
  if (!code || !state) return bounce('Google sign-in came back incomplete — try again');
  if (!flow) {
    return bounce('this sign-in took too long, or started in another browser — try again');
  }

  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/auth/google/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, state, flow }),
      cache: 'no-store',
    });
  } catch {
    return bounce('the Potion API is unreachable — try the email link');
  }
  const body = (await res.json().catch(() => null)) as
    | { token?: string; error?: { message?: string } }
    | null;
  if (!res.ok || !body?.token) {
    return bounce(body?.error?.message ?? 'Google sign-in failed — try the email link');
  }

  const out = clearFlow(NextResponse.redirect(new URL('/', origin)));
  out.cookies.set(SESSION_COOKIE, body.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return out;
}

/** One cookie out of a Cookie header, without pulling in a parser. */
function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
