import { proxyJson } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

/** Validate a provider key (M2 #16) — test call through the provider with
 * the decrypted key; records last_validated_at. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyJson(`/api/keys/${encodeURIComponent(id)}/validate`, { method: 'POST' });
}
