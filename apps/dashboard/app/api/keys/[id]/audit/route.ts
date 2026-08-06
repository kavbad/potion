import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

/** Per-key custody audit trail (M2 #16). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/api/keys/${encodeURIComponent(id)}/audit`, { method: 'GET' });
}
