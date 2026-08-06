import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clusterId: string }> },
) {
  const { clusterId } = await params;
  return proxyJson(`/api/frontiers/${encodeURIComponent(clusterId)}`, { method: 'GET' });
}
