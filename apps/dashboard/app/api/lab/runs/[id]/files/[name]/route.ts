// X1: artifact download — a BINARY passthrough (proxyJson is JSON-only),
// same session-cookie forwarding, headers relayed so the browser saves the
// file under its real name and type.
import { apiUrl, sessionCookieHeader } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await ctx.params;
  const cookie = await sessionCookieHeader();
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/api/lab/runs/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`, {
      cache: 'no-store',
      headers: { ...(cookie ? { cookie } : {}) },
    });
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Potion API unreachable' } }), { status: 502 });
  }
  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition', 'x-content-sha256']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
