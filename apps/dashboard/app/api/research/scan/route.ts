// Research scan (M4b #37): POST /api/research/scan — diff the model catalog
// for new models and enqueue evaluation cycles (admin; the API enforces).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => undefined);
  return proxyJson('/api/research/scan', { method: 'POST', ...(body !== null ? { body } : {}) });
}
