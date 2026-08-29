// BYO-MCP: register an org's own MCP endpoint (admin; server re-probes).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('/api/lab/connectors/custom', { method: 'POST', body });
}
