// X3 UX: the home feed's lab source (route ships with its proxy — law).
import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  return proxyJson('/api/lab/recent', { method: 'GET' });
}
