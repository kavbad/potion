// Lab (Step 8): memory edit (member) + permanent delete (admin server-side).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function PUT(req: Request, ctx: { params: Promise<{ hash: string; key: string }> }) {
  const { hash, key } = await ctx.params;
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson(`/api/lab/memory/${encodeURIComponent(hash)}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body,
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ hash: string; key: string }> }) {
  const { hash, key } = await ctx.params;
  return proxyJson(`/api/lab/memory/${encodeURIComponent(hash)}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}
