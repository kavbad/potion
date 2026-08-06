// Trace waterfall (M5 #36): GET /api/traces/:traceId — spans in waterfall
// order with per-span cost attribution. Proxied with the caller's session
// cookie.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  return proxyJson(`/api/traces/${encodeURIComponent(traceId)}`, { method: 'GET' });
}
