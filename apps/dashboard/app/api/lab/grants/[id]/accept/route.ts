// Lab (L-G3): accept a graduation proposal (admin) — the ONLY path to
// autonomous; the server floors the audit rate and refuses never-graduates.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/lab/grants/${encodeURIComponent(id)}/accept`, { method: 'POST' });
}
