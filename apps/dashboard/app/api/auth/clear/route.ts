// /api/auth/clear — drop a session cookie the API no longer honours.
//
// middleware.ts checks cookie PRESENCE, not validity, and that is the right
// split: the API server is the authority on a session, and re-validating on
// every navigation would put a network call in front of every page. The cost
// is that an expired, revoked, or reset-database cookie still looks signed-in
// to the dashboard — the page renders, calls the API, and takes a 401.
//
// Redirecting such a request straight to /login was a dead end: nothing
// cleared the cookie, so the visitor arrived signed-out-but-not-really and
// every route kept failing the same way, including the public landing page,
// which they could not reach at all. This route is the missing step. A server
// component cannot set cookies; a route handler can.
//
// Separate from /api/auth/logout on purpose: logout is a deliberate act that
// should also revoke server-side and land on /login. This is recovery from a
// credential that is already dead, and it returns the visitor to wherever
// they were trying to go.
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/api';
import { publicOrigin } from '@/lib/origin';

export const dynamic = 'force-dynamic';

/**
 * Only same-origin relative paths. `to` reaches this handler from a URL, so
 * without this an attacker-supplied `?to=https://evil.example` would turn a
 * Potion link into an open redirect. A leading `//` is rejected too — it is
 * protocol-relative and leaves the origin.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/login';
  return raw;
}

export function GET(req: Request): NextResponse {
  const to = safeNext(new URL(req.url).searchParams.get('to'));
  // `cleared` is a loop guard, not decoration. If the cookie somehow survives
  // this response, the destination must not bounce straight back here.
  const dest = new URL(to, publicOrigin(req));
  dest.searchParams.set('cleared', '1');
  const out = NextResponse.redirect(dest);
  out.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return out;
}
