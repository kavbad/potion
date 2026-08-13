// Lab (Step 8): the narration/ticker poll — durable rows, no streaming.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/runs/${encodeURIComponent(id)}`, { method: 'GET' });
}
