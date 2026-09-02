import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/holdout', { method: 'GET' });
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => ({}));
  return proxyJson('/api/holdout', { method: 'PUT', body });
}
