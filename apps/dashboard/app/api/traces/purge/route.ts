// Trace purge (M5 #36): POST /api/traces/purge — enforce the org's retention
// policy NOW (admin; the API enforces the role and scopes to the caller's
// org). Proxied with the caller's session cookie.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST() {
  return proxyJson('/api/traces/purge', { method: 'POST' });
}
