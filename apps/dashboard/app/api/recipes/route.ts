// Recipe library (M4b #37): GET /api/recipes?cluster&status — proxied to
// apps/server with the caller's session cookie (viewer+).
import { proxyJson } from '@/lib/proxy';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return proxyJson(`/api/recipes${req.nextUrl.search}`, { method: 'GET' });
}
