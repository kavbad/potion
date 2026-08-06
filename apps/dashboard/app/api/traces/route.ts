// Trace rollup (M5 #36): GET /api/traces?from&to&limit — sessions grouped by
// trace id with cost, models, and loop signals. Proxied with the caller's
// session cookie.
import { proxyJson } from '@/lib/proxy';
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return proxyJson(`/api/traces${req.nextUrl.search}`, { method: 'GET' });
}
