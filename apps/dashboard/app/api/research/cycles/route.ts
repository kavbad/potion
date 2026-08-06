// Research cycles (M4b #37): GET /api/research/cycles — recent cycles (the
// lineage behind /recipes rows). Proxied with the caller's session cookie.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/research/cycles', { method: 'GET' });
}
