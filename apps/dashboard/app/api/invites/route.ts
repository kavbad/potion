import { proxyJson } from '@/lib/proxy';
export const dynamic = 'force-dynamic';
export async function GET() {
  return proxyJson('/api/invites', { method: 'GET' });
}
export async function POST(req: Request) {
  return proxyJson('/api/invites', { method: 'POST', body: await req.json() });
}
