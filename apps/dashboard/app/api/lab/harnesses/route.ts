// Lab (Step 8): interview submit + harness list — thin proxies to apps/server.
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/lab/harnesses', { method: 'GET' });
}

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('/api/lab/harnesses', { method: 'POST', body });
}
