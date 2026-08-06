// GET /api/auth/me (M2 #14): the caller's session identity (user/org/role) —
// powers the nav session badge. Proxied from the API server with the session
// cookie forwarded.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/auth/me', { method: 'GET' });
}
