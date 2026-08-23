import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST() {
  return proxyJson('/api/learning/run', { method: 'POST' });
}
