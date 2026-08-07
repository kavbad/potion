// Rubric approval (G1.5): the API demotes the prior approved rubric and
// restamps the suite's items in one transaction (admin-gated server-side).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/api/rubrics/${encodeURIComponent(id)}/approve`, { method: 'POST' });
}
