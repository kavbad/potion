// Auth guard (M2 Wave 2, ROADMAP #14): every dashboard page + proxy route
// requires a Potion session cookie. Signed-out page requests redirect to
// /login; signed-out /api/* proxy calls get a 401 JSON (they are fetch
// targets, not navigations). /login and /api/auth/* (the sign-in flow
// itself) stay open. Presence-only check — the API server re-validates the
// session on every forwarded call, so a forged/expired cookie still 401s.
import { NextResponse, type NextRequest } from 'next/server';

// M4 #31: /share/f|/share/r are PUBLIC read-only pages (the st_… token is
// the credential). /api/share (mint/list/revoke) stays guarded — it is an
// /api/* path, not a /share/* one.
// M4b #32: /leaderboard is PUBLIC (live-verified recipes only) — no proxy
// route needed; the page fetches /api/leaderboard server-side.
const OPEN_PREFIXES = ['/login', '/api/auth', '/share/', '/leaderboard'];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (OPEN_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (req.cookies.get('potion_session')?.value) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: { message: 'not signed in', type: 'authentication_required' } },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
