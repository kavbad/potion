// Lab (Step 8): start a trial run.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('/api/lab/runs', { method: 'POST', body });
}
