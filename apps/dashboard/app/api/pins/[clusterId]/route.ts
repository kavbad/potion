import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function PUT(_req: Request, { params }: { params: Promise<{ clusterId: string }> }) {
  const { clusterId } = await params;
  return proxyJson(`/api/pins/${encodeURIComponent(clusterId)}`, { method: 'PUT', body: {} });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ clusterId: string }> }) {
  const { clusterId } = await params;
  return proxyJson(`/api/pins/${encodeURIComponent(clusterId)}`, { method: 'DELETE' });
}
