// /settings/keys — the token surface a developer expects to find.
//
// Closes a real gap: `serve+admin` existed in the API and there was no
// supported way to obtain one, so nothing programmatic (CI, Terraform, a
// provisioning script) could get past a 403. See ApiKeysManager for the
// scope reasoning.
import { ApiKeysManager } from '@/components/api-keys-manager';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import type { ConnectionResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  let conn: ConnectionResponse | null = null;
  try {
    conn = await apiFetch<ConnectionResponse>('/api/connection');
  } catch (e) {
    if (!(e instanceof ApiUnreachable)) throw e;
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        One token type for your application, one for your infrastructure. Everything the dashboard
        does is an HTTP call you can make yourself — see{' '}
        <a href="/docs" className="text-accent underline">the docs</a> for the full surface.
      </p>
      <ApiKeysManager initial={conn?.servingKeys ?? []} />
    </div>
  );
}
