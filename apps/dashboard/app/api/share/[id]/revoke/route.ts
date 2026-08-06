// Share-link revoke (M4 #31) — proxied POST (admin role enforced server-side).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/api/share/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}
