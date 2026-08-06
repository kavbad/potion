import { NextResponse } from 'next/server';
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const policy = new URL(req.url).searchParams.get('policy');
  if (!policy) {
    return NextResponse.json(
      { error: { message: '?policy= query required', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }
  return proxyJson(`/api/endpoint-snippet?policy=${encodeURIComponent(policy)}`, {
    method: 'GET',
  });
}
