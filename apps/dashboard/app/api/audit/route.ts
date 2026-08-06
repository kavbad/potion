// Unified audit read (M4 #34) — admin-only recent-100 events, proxied with
// the caller's session cookie.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/audit', { method: 'GET' });
}
