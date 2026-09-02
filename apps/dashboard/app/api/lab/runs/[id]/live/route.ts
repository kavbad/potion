// LIVE OUTPUT (2026-09-02): the in-flight sandbox tail (the recurring-class
// rule: proxy ships WITH the server route).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/runs/${encodeURIComponent(id)}/live`, { method: 'GET' });
}
