// Share links (M4 #31): list (GET) + mint (POST) — proxied to apps/server
// with the caller's session cookie.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/share', { method: 'GET' });
}

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  return proxyJson('/api/share', { method: 'POST', body });
}
