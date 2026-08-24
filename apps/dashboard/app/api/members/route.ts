import { proxyJson } from '@/lib/proxy';
export const dynamic = 'force-dynamic';
export async function GET() {
  return proxyJson('/api/members', { method: 'GET' });
}
