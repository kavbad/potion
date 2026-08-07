// Rubric rejection (G1.5): a reason is REQUIRED — rejected rubrics stay
// listed with their reason (visible rigor, never hidden).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body: unknown = await req.json().catch(() => undefined);
  return proxyJson(`/api/rubrics/${encodeURIComponent(id)}/reject`, { method: 'POST', body: body ?? {} });
}
