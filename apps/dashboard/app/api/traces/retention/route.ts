// Trace retention (M5 #36): GET/PUT /api/traces/retention — the org's trace
// retention policy in days (0 = metadata-only after purge). PUT is admin;
// the API enforces the role.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/traces/retention', { method: 'GET' });
}

export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => undefined);
  return proxyJson('/api/traces/retention', { method: 'PUT', body });
}
