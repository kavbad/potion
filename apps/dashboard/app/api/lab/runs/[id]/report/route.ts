// Lab (Step 8): run report v1 — evidence before advice.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/runs/${encodeURIComponent(id)}/report`, { method: 'GET' });
}
