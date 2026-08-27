// Lab (L-G3): the permission ledger read — stored grants + evidence rollup
// + observed-ungranted classes. This proxy was MISSING: the ledger 404'd
// client-side and rendered nothing on the specimen page.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  return proxyJson(`/api/lab/harnesses/${encodeURIComponent(hash)}/grants`, { method: 'GET' });
}
