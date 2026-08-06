// Trace clustering trigger (M5 #36): POST /api/traces/cluster — enqueue a
// traces:cluster job for the caller's org (admin; the API enforces the role
// and forces the payload orgId to the caller's org).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => undefined);
  return proxyJson('/api/traces/cluster', { method: 'POST', body: body ?? {} });
}
