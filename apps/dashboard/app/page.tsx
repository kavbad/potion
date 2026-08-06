// / — connect provider keys (SPEC §9 flow 1). Server component renders the
// masked list of stored keys; the form + per-key actions are client islands.
//
// BYOK custody (M2 Wave 2, ROADMAP #16): keys are ENCRYPTED AT REST
// (AES-256-GCM envelope — per-key data key wrapped by the master key) and
// serve their org's traffic; platform keys remain the fallback for providers
// without a connected key. The M1a honesty banner and the flag gate are gone
// — custody shipped. NEXT_PUBLIC_BYOK_ENABLED stays as an emergency opt-out
// (default ON; set to 'false' to hide the self-serve form).
import { KeyActions } from '@/components/key-actions';
import { KeysForm } from '@/components/keys-form';
import { ApiUnreachable, apiFetch } from '@/lib/api';
import { CUSTODY_NOTE } from '@/lib/provenance';
import type { KeysResponse, ProviderKeyStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Emergency opt-out only — custody is shipped, so the form defaults ON. */
function byokEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BYOK_ENABLED !== 'false';
}

const STATUS_STYLE: Record<ProviderKeyStatus, string> = {
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  revoked: 'border-red-200 bg-red-50 text-red-700',
  rotating: 'border-amber-200 bg-amber-50 text-amber-700',
};

export default async function ConnectKeysPage() {
  let keys: KeysResponse['keys'] = [];
  let unreachable = false;
  try {
    keys = (await apiFetch<KeysResponse>('/api/keys')).keys;
  } catch (e) {
    if (e instanceof ApiUnreachable) unreachable = true;
    else throw e;
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Connect keys</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Bring your own provider keys and Potion bills your accounts directly. Connected keys serve
        your org&apos;s traffic for their provider; Potion platform keys remain the fallback
        everywhere else.
      </p>

      {/* custody note (M2 #16 — replaces the M1a honesty banner) */}
      <div className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-6 py-4">
        <p className="text-sm font-medium text-emerald-800">{CUSTODY_NOTE}</p>
      </div>

      <div className="rounded-xl border border-line bg-panel px-8 py-8">
        {byokEnabled() ? (
          <KeysForm />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-soft">
              Self-serve key connection is disabled in this deployment
              (NEXT_PUBLIC_BYOK_ENABLED=false).
            </p>
            <p className="text-sm text-soft">
              Need a provider key connected?{' '}
              <span className="font-medium text-ink">Contact us</span> at{' '}
              <a href="mailto:support@potion.dev" className="text-accent underline">
                support@potion.dev
              </a>{' '}
              and we will add it for you.
            </p>
          </div>
        )}
        <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-faint">
          <span className="font-medium text-soft">Platform-keys fallback:</span> no key connected
          for a provider? Potion serves that provider on its own platform keys (in this demo:
          built-in mock providers). Connected keys take over serving — and billing — for their
          provider immediately.
        </p>
      </div>

      <h2 className="mb-4 mt-12 text-sm font-medium text-ink">
        Connected keys {keys.length > 0 && <span className="text-faint">({keys.length})</span>}
      </h2>
      {unreachable ? (
        <div className="rounded-lg border border-line bg-panel p-6 text-sm text-soft">
          The Potion API is not reachable. Start <code className="font-mono">apps/server</code>{' '}
          (default port 3000) and reload.
        </div>
      ) : keys.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6 text-sm text-faint">
          None yet — you are on platform keys.
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
          {keys.map((k) => (
            <li key={k.id} className="px-6 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{k.name}</span>
                    {k.status && (
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[k.status]}`}
                      >
                        {k.status}
                      </span>
                    )}
                  </div>
                  <div className="text-xs capitalize text-faint">
                    {k.provider}
                    {k.keyVersion ? ` · key v${k.keyVersion}` : ''}
                    {k.lastValidatedAt
                      ? ` · validated ${new Date(k.lastValidatedAt).toLocaleString()}`
                      : ' · not validated yet'}
                  </div>
                </div>
                <code className="rounded bg-paper px-2 py-1 font-mono text-xs text-soft">
                  {k.maskedKey}
                </code>
              </div>
              {k.status && <KeyActions id={k.id} status={k.status} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
