// P1 (the clock): arm a standing mission. Created WITH the server route
// (the recurring-class rule: a route without its proxy 404s silently).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  return proxyJson(`/api/lab/harnesses/${encodeURIComponent(hash)}/arm`, { method: 'POST' });
}
