// Lab (Step 10): start the PKCE flow for a connector (admin).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/connectors/${encodeURIComponent(id)}/oauth/start`, { method: 'POST' });
}
