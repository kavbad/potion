// The open hood (2026-08-27): whole-spec-file save. The server enforces
// every custody gate and returns TYPED issues on refusal — this proxy
// relays them verbatim (the machinery view renders path + code + message).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function PUT(req: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as unknown;
  return proxyJson(`/api/lab/harnesses/${encodeURIComponent(hash)}/spec`, { method: 'PUT', body });
}
