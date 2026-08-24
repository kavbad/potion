import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

export async function POST() {
  return proxyJson('/api/billing/payment-method', { method: 'POST', body: {} });
}
