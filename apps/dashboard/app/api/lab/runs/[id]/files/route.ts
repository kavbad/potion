// X1: the run's artifact list (the recurring-class rule: proxy ships WITH
// the server route).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/runs/${encodeURIComponent(id)}/files`, { method: 'GET' });
}
