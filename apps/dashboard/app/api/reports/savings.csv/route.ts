// GET /api/reports/savings.csv?from&to — streams the server's savings CSV
// export with its attachment content-disposition intact (same pattern as
// /api/usage/export.csv). Forwards the caller's session cookie (M2 #14).
import { NextResponse, type NextRequest } from 'next/server';
import { apiUrl, sessionCookieHeader } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cookie = await sessionCookieHeader();
  const upstream = await fetch(`${apiUrl()}/api/reports/savings.csv${req.nextUrl.search}`, {
    cache: 'no-store',
    headers: { ...(cookie ? { cookie } : {}) },
  }).catch(() => null);
  if (!upstream) {
    return NextResponse.json(
      { error: { message: `Potion API unreachable at ${apiUrl()}`, type: 'api_unreachable' } },
      { status: 502 },
    );
  }
  const body = await upstream.text();
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'text/csv',
  });
  const disp = upstream.headers.get('content-disposition');
  if (disp) headers.set('content-disposition', disp);
  return new NextResponse(body, { status: upstream.status, headers });
}
