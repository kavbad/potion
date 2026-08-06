import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

/** Resolve a guarantee incident (M3 #22) — lifts a rollback's
 * operating-point override. Admin role enforced by apps/server. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/api/incidents/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
}
