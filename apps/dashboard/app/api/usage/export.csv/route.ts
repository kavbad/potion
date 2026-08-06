// GET /api/usage/export.csv?from&to — streams the server's CSV export with
// its attachment content-disposition intact.
import { NextResponse, type NextRequest } from 'next/server';
import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const upstream = await fetch(`${apiUrl()}/api/usage/export.csv${req.nextUrl.search}`, {
    cache: 'no-store',
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
