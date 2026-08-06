// POST /api/auth/request-link — start the magic-link flow (M2 #14). Proxies
// to the API server; when the server is in dev mode and returns a devLink,
// it is rewritten to hit THIS dashboard's /api/auth/verify so the session
// cookie lands on the dashboard origin.
import { NextResponse } from 'next/server';
import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  const email =
    body && typeof body === 'object' && typeof (body as { email?: unknown }).email === 'string'
      ? (body as { email: string }).email
      : null;
  if (!email) {
    return NextResponse.json(
      { error: { message: 'email required', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/auth/request-link`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  } catch {
    return NextResponse.json(
      { error: { message: 'Potion API unreachable — start apps/server first.', type: 'api_unreachable' } },
      { status: 502 },
    );
  }
  const data = (await res.json().catch(() => null)) as { devLink?: string } | null;
  if (data?.devLink) {
    try {
      const token = new URL(data.devLink).searchParams.get('token');
      if (token) data.devLink = `/api/auth/verify?token=${encodeURIComponent(token)}`;
    } catch {
      delete data.devLink;
    }
  }
  return NextResponse.json(data, { status: res.status });
}
