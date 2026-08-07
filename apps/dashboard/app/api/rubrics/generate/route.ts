// Rubric generation trigger (G1.5): POST /api/rubrics/generate — enqueue a
// rubric:generate job for one of the caller's clusters (admin; the API
// enforces the role and cluster ownership).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => undefined);
  return proxyJson('/api/rubrics/generate', { method: 'POST', body: body ?? {} });
}
