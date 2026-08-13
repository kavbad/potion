// Lab (Step 8): harness detail (spec + sidecar + dial views).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  return proxyJson(`/api/lab/harnesses/${encodeURIComponent(hash)}`, { method: 'GET' });
}
