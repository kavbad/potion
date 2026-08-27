// R1: the org's compiled router — proxied like every dashboard read.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/router', { method: 'GET' });
}
