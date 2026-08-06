import type { NextRequest } from 'next/server';
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return proxyJson(`/api/usage${req.nextUrl.search}`, { method: 'GET' });
}
