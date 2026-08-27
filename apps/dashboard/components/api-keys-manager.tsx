'use client';

// API KEYS — and the scope choice that was missing entirely.
//
// THE GAP THIS CLOSES. The serving path, the plan endpoint, connection
// details and routing activity are all reachable with a Bearer token — the
// dashboard is a thin client over the same HTTP API. But a self-serve org
// could not OBTAIN a token able to provision: `POST /api/policies` mints keys
// without scopes (so, serve-only → role member), and the connect page's
// "issue a key" button posts a name and nothing else. `serve+admin` existed
// in the API with no supported way to get one, so anything programmatic —
// CI, Terraform, a provisioning script — dead-ended at a 403 nobody could
// resolve from the product.
//
// Scope is therefore a deliberate choice here, not a default, and the copy
// says what each one can do. Serve-only stays the recommendation: it is what
// belongs in an application, and a leaked serving key should not be able to
// mint more keys.
import { useState } from 'react';
import { CopyBlock } from '@/components/copy-block';
import type { ServingKeyDto } from '@/lib/types';

type Scope = 'serve' | 'serve+admin';

const SCOPES: Array<{ value: Scope; title: string; blurb: string; caution?: string }> = [
  {
    value: 'serve',
    title: 'Serving key',
    blurb:
      'Sends traffic to the endpoint, reads its own connection details, and can rebind its own policy. This is what goes in your application.',
  },
  {
    value: 'serve+admin',
    title: 'Admin token',
    blurb:
      'Everything a serving key can do, plus provisioning: mint keys, create policies, set budgets. For CI, scripts and infrastructure-as-code.',
    caution: 'Treat like a password — it can create credentials for your whole workspace.',
  },
];

function state(k: ServingKeyDto): { label: string; cls: string } {
  if (k.revokedAt) return { label: 'revoked', cls: 'border-red-200 bg-red-50 text-red-700' };
  if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) {
    return { label: 'expired', cls: 'border-amber-200 bg-amber-50 text-amber-700' };
  }
  return { label: 'active', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
}

export function ApiKeysManager({ initial }: { initial: ServingKeyDto[] }) {
  const [keys, setKeys] = useState(initial);
  const [scope, setScope] = useState<Scope>('serve');
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function issue() {
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || `${scope === 'serve' ? 'serving' : 'admin'}-${new Date().toISOString().slice(0, 10)}`,
          scopes: scope,
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: { message?: string } }).error?.message ?? res.statusText)
            : res.statusText;
        throw new Error(message);
      }
      setIssued((body as { apiKey: string }).apiKey);
      setName('');
      const listed = await fetch('/api/api-keys', { cache: 'no-store' });
      if (listed.ok) setKeys(((await listed.json()) as { keys: ServingKeyDto[] }).keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-10">
      {issued && (
        <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 px-6 py-5">
          <p className="text-sm font-medium text-emerald-800">
            Copy it now — this is the only time it is shown.
          </p>
          <CopyBlock label="Your new key" text={issued} />
        </div>
      )}

      <section className="space-y-4">
        <h2 className="text-sm font-medium text-ink">Create a key</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setScope(s.value)}
              className={`rounded-xl border px-5 py-4 text-left transition-colors ${
                scope === s.value ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:border-soft'
              }`}
            >
              <div className="text-sm font-medium text-ink">{s.title}</div>
              <p className="mt-1 text-xs leading-relaxed text-soft">{s.blurb}</p>
              {s.caution && (
                <p className="mt-2 text-xs font-medium text-warn">{s.caution}</p>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional) — e.g. production, ci"
            className="min-w-[16rem] flex-1 rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <button
            onClick={() => void issue()}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create key'}
          </button>
          {error && <span className="text-sm text-warn">{error}</span>}
        </div>
        <p className="text-xs leading-relaxed text-faint">
          Potion stores only a hash, so a key can never be shown again after it is created — not to
          you, and not to us. Lost one? Create another; existing keys keep working until revoked.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-medium text-ink">
          Your keys {keys.length > 0 && <span className="text-faint">({keys.length})</span>}
        </h2>
        {keys.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-6 py-6 text-sm text-faint">
            None yet.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
            {keys.map((k) => {
              const st = state(k);
              return (
                <li key={k.id} className="flex items-center justify-between px-6 py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink">{k.name}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide ${st.cls}`}
                      >
                        {st.label}
                      </span>
                      {k.scopes === 'serve+admin' && (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide text-amber-700">
                          admin
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-faint">
                      <span className="font-mono">{k.id}</span>
                      {k.scopes ? ` · ${k.scopes}` : ''}
                      {k.createdAt ? ` · created ${new Date(k.createdAt).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
