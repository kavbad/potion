import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

/** Revoke a provider key (M2 #16) — serving stops immediately. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}
