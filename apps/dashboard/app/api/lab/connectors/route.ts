// Lab (Step 10/11): the connector catalog + grant statuses. This proxy was
// MISSING — the ConnectorPanel 404'd silently and rendered nothing, which
// is exactly how a worker that declared gmail showed no way to connect it.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/lab/connectors', { method: 'GET' });
}
