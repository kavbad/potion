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
const OPEN_PREFIXES = ['/login', '/api/auth', '/share/', '/leaderboard', '/docs', '/home', '/hero-lab', '/research', '/sitemap.xml', '/robots.txt'];

// '/' is public (the landing page) and MUST be matched exactly. It cannot go
// in OPEN_PREFIXES: every path startsWith('/'), so one entry there would make
// the entire dashboard anonymous. Exact-match set, deliberately separate.
const OPEN_EXACT = new Set(['/']);

/**
 * Pass the request through, tagging it with its own pathname.
 *
 * app/layout.tsx needs the path to decide which chrome to draw, and a layout
 * cannot see it — Next gives layouts no pathname. A request header set here
 * is the supported way across. It is derived from req.nextUrl, never from an
 * inbound header, so a client cannot forge it.
 *
 * The query string rides along for lib/recover.ts, which needs the whole URL
 * — a page recovering from a dead session sends the visitor back to where
 * they were headed, and on /usage or /reports the date range IS where they
 * were headed. Kept as a SEPARATE header rather than appended to
 * x-potion-path, because the layout's chrome test is a path test and would
 * quietly start comparing query strings too.
 */
function pass(req: NextRequest): NextResponse {
  const res = NextResponse.next();
  res.headers.set('x-potion-path', req.nextUrl.pathname);
  res.headers.set('x-potion-search', req.nextUrl.search);
  return res;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (OPEN_EXACT.has(pathname)) return pass(req);
  if (OPEN_PREFIXES.some((p) => pathname.startsWith(p))) return pass(req);
  if (req.cookies.get('potion_session')?.value) return pass(req);

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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
