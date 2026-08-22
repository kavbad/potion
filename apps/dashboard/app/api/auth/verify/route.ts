// GET /api/auth/verify?token=ml_… — finish the magic-link flow (M2 #14):
// the API server consumes the link + mints the session; this handler plants
// the session cookie on the DASHBOARD origin and redirects home. Failures
// bounce back to /login with an error note.
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // must match server SESSION_TTL_MS

/**
 * The origin a browser should be sent back to. Behind the production proxy
 * `req.url` is the CONTAINER's address (localhost:3001) — redirecting there
 * sent a real sign-in to the partner's own machine (caught in the Phase D
 * rehearsal, 2026-08-21). Prefer the configured public URL, then the proxy's
 * forwarded headers, then the request itself (local dev).
 */
function publicOrigin(req: Request): string {
  const configured = process.env.POTION_APP_URL?.replace(/\/$/, '');
  if (configured) return configured;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = publicOrigin(req);
  const token = url.searchParams.get('token');
  const login = (error: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, origin));
  if (!token) return login('missing sign-in token');

  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/auth/verify?token=${encodeURIComponent(token)}`, {
      cache: 'no-store',
    });
  } catch {
    return login('Potion API unreachable — start apps/server first.');
  }
  if (!res.ok) return login('that link is invalid, expired, or already used');

  const data = (await res.json().catch(() => null)) as { token?: string } | null;
  if (!data?.token) return login('sign-in failed — request a fresh link');

  const out = NextResponse.redirect(new URL('/', origin));
  out.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: origin.startsWith('https://'),
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return out;
}
