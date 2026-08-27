// O2: candidate policy → the router it would compile (pure preview).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as unknown;
  return proxyJson('/api/router/whatif', { method: 'POST', ...(body !== null ? { body } : {}) });
}
