// /api/auth/logout (M2 #14): revoke the session server-side (best effort),
// clear the dashboard cookie, land on /login. GET so a plain nav link works.
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

async function logout(req: Request) {
  const cookie = req.headers.get('cookie') ?? '';
  await fetch(`${apiUrl()}/auth/logout`, { method: 'POST', cache: 'no-store', headers: { cookie } }).catch(
    () => null, // best effort — the cookie is cleared regardless
  );
  const out = NextResponse.redirect(new URL('/login', req.url));
  out.cookies.set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return out;
}

export { logout as GET, logout as POST };
