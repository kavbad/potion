// Recipe evaluate (M4b #37): POST /api/recipes/:hash/evaluate — enqueue a
// single-recipe research cycle (admin; the API enforces the role).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return proxyJson(`/api/recipes/${encodeURIComponent(hash)}/evaluate`, { method: 'POST' });
}
