// P2-9: support messages, proxied with the caller's session.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  return proxyJson('/api/support', { method: 'POST', body });
}
