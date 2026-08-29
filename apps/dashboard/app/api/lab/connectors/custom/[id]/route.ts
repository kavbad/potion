// BYO-MCP: remove a registered endpoint (revokes its grant; typed cut).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/connectors/custom/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
