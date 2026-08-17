import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/connection', { method: 'GET' });
}
