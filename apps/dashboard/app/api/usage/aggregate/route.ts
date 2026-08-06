// POST /api/usage/aggregate?from&to — triggers the idempotent server-side
// usage rollup for the window, then redirects back to /usage (native form
// POST, no JS required).
import { NextResponse, type NextRequest } from 'next/server';
import { apiUrl } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const from = req.nextUrl.searchParams.get('from');
  const to = req.nextUrl.searchParams.get('to');
  await fetch(`${apiUrl()}/api/usage/aggregate`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to }),
  }).catch(() => null);
  const back = new URL('/usage', req.nextUrl.origin);
  if (from) back.searchParams.set('from', from);
  if (to) back.searchParams.set('to', to);
  return NextResponse.redirect(back, 303);
}
