// Lab (Step 10): revoke a connector grant (admin) — the typed cut.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/connectors/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
}
