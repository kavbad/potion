// Lab (L-G3): run the graduation pass (admin) — viewing the ledger IS the
// evaluation moment; auto-tighten may fire here, fail closed.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  return proxyJson(`/api/lab/harnesses/${encodeURIComponent(hash)}/grants/evaluate`, { method: 'POST' });
}
