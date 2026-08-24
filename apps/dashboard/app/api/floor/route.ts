// P1-7: the org-wide quality floor, set from /settings/controls (admin).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  return proxyJson('/api/floor', { method: 'PUT', body });
}
