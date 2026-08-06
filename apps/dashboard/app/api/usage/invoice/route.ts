// GET /api/usage/invoice?period&format&margin_pct — streams the server's
// invoice (JSON or print-friendly HTML) back to the browser. HTML downloads
// as an attachment so the "Download invoice" button saves a file.
import { NextResponse, type NextRequest } from 'next/server';
import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const upstream = await fetch(`${apiUrl()}/api/usage/invoice${req.nextUrl.search}`, {
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
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
  });
  if ((upstream.headers.get('content-type') ?? '').includes('text/html')) {
    const period = req.nextUrl.searchParams.get('period') ?? 'invoice';
    headers.set('content-disposition', `attachment; filename="potion-invoice-${period}.html"`);
  }
  return new NextResponse(body, { status: upstream.status, headers });
}
