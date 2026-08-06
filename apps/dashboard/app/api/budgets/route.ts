// Budget autopilot (M4 #35) — GET (state read) + PUT (admin upsert) proxied
// to apps/server with the caller's session cookie.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/budgets', { method: 'GET' });
}

export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  return proxyJson('/api/budgets', { method: 'PUT', body });
}
