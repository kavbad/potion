import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const limit = new URL(req.url).searchParams.get('limit');
  // The server clamps this; forwarding it unvalidated is safe and keeps one
  // place responsible for the bound.
  const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  return proxyJson(`/api/routing-activity${qs}`, { method: 'GET' });
}
