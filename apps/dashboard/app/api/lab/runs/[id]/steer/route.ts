// X8: steer a running worker (member; guidance, never authorization).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(`/api/lab/runs/${encodeURIComponent(id)}/steer`, { method: 'POST', body });
}
