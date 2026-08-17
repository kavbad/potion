// Serving keys (`pk_…`) — distinct from /api/keys, which is BYOK PROVIDER
// keys. POST returns the raw key EXACTLY ONCE (only its sha256 is stored),
// which is why the page issues a new key rather than pretending to reveal an
// old one.
import { NextResponse } from 'next/server';
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/api-keys', { method: 'GET' });
}

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: { message: 'JSON body required', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }
  return proxyJson('/api/api-keys', { method: 'POST', body });
}
