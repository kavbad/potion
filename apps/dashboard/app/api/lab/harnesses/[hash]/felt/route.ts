// Lab (Step 8): felt sweep (cap-bound, cached server-side).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(`/api/lab/harnesses/${encodeURIComponent(hash)}/felt`, { method: 'POST', body });
}
