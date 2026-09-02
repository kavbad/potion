import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/api/workloads/${encodeURIComponent(id)}/retire`, { method: 'POST' });
}
