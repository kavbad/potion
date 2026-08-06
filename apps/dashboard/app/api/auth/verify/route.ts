// GET /api/auth/verify?token=ml_… — finish the magic-link flow (M2 #14):
// the API server consumes the link + mints the session; this handler plants
// the session cookie on the DASHBOARD origin and redirects home. Failures
// bounce back to /login with an error note.
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // must match server SESSION_TTL_MS

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const login = (error: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, url));
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

  const out = NextResponse.redirect(new URL('/', url));
  out.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return out;
}
