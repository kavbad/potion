import { NextResponse } from 'next/server';
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

/** Rotate a provider key's raw material (M2 #16) — body: {apiKey}. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: { message: 'JSON body required', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }
  return proxyJson(`/api/keys/${encodeURIComponent(id)}/rotate`, { method: 'POST', body });
}
