// POST /api/auth/verify-code {email, code} — the type-able sign-in
// (2026-08-28). The server consumes the code and mints the session; this
// handler plants the cookie on the dashboard origin, exactly like the
// link's verify route (same cookie attributes — the two paths must not
// drift).
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // must match server SESSION_TTL_MS

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { email?: string; code?: string } | null;
  if (!body?.email || !body.code) {
    return NextResponse.json({ error: { message: 'email and code are required' } }, { status: 400 });
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/auth/verify-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: body.email, code: body.code.replace(/\D/g, '') }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: { message: 'Potion API unreachable' } }, { status: 502 });
  }
  const data = (await res.json().catch(() => null)) as { token?: string; error?: { message?: string } } | null;
  if (!res.ok || !data?.token) {
    return NextResponse.json(
      { error: { message: data?.error?.message ?? 'that code is invalid, expired, or already used' } },
      { status: res.status === 429 ? 429 : 401 },
    );
  }
  const out = NextResponse.json({ ok: true });
  out.cookies.set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
  return out;
}
