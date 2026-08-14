// Lab (Step 9): plain-language spec patch → NEW content-addressed row.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(`/api/lab/harnesses/${encodeURIComponent(hash)}/edit`, { method: 'POST', body });
}
