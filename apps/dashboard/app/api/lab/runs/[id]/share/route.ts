// H2: mint a shareable deliverable page (admin; server re-derives, scans,
// verifies and freezes — the dashboard is a thin shell).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/runs/${encodeURIComponent(id)}/share`, { method: 'POST' });
}
