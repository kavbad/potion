import { NextResponse } from 'next/server';
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/incumbents', { method: 'GET' });
}

export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: { message: 'JSON body required', type: 'invalid_request_error' } }, { status: 400 });
  }
  return proxyJson('/api/incumbents', { method: 'PUT', body });
}
