import { proxyJson } from '@/lib/proxy';
export const dynamic = 'force-dynamic';
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/api/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
