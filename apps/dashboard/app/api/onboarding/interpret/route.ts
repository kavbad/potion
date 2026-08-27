// O1: description → interpreted mix + the instant reveal.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as unknown;
  return proxyJson('/api/onboarding/interpret', { method: 'POST', ...(body !== null ? { body } : {}) });
}
