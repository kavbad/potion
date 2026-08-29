// BYO-MCP: probe an MCP endpoint — preview the pinned surface, store nothing.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('/api/lab/connectors/custom/probe', { method: 'POST', body });
}
