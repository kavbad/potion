'use client';

// SERVING KEYS — issue, list, and be honest about what cannot be shown.
//
// The raw `pk_…` is never stored (only its sha256), so a key that was
// displayed once is gone. Before this the product handled that by displaying
// it once and saying nothing more, which reads as "you lost it, start over";
// the fix is not to reveal old keys — that is impossible and would be a worse
// product if it weren't — but to make ISSUING a replacement a one-click,
// obviously-safe action, and to say plainly why.
import { useState } from 'react';
import { CopyBlock } from '@/components/copy-block';
import type { ServingKeyDto } from '@/lib/types';

function keyState(k: ServingKeyDto): { label: string; cls: string } {
  if (k.revokedAt) return { label: 'revoked', cls: 'border-red-200 bg-red-50 text-red-700' };
  if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) {
    return { label: 'expired', cls: 'border-amber-200 bg-amber-50 text-amber-700' };
  }
  return { label: 'active', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
}

export function ServingKeys({ initial }: { initial: ServingKeyDto[] }) {
  const [keys, setKeys] = useState(initial);
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `serving-${new Date().toISOString().slice(0, 10)}` }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? String((body as { error: { message?: string } }).error?.message ?? res.statusText)
            : res.statusText;
        throw new Error(message);
      }
      const created = body as { apiKey: string } & ServingKeyDto;
      setIssued(created.apiKey);
      const listed = await fetch('/api/api-keys', { cache: 'no-store' });
      if (listed.ok) setKeys(((await listed.json()) as { keys: ServingKeyDto[] }).keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const live = keys.filter((k) => keyState(k).label === 'active');

  return (
    <div className="space-y-5">
      {issued && (
        <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 px-6 py-5">
          <p className="text-sm font-medium text-emerald-800">
            New serving key — copy it now. This is the only time it is shown.
          </p>
          <CopyBlock label="POTION_API_KEY" text={issued} />
        </div>
      )}

      {keys.length === 0 ? (
        <p className="text-sm text-faint">
          No serving key yet. Issue one; it comes with a default rule (the cheapest model that clears the highest bar every kind of work can prove today) that you can change later.
        </p>
      ) : (
        <ul className="divide-y divide-line border border-[#d9d5cb] bg-[#fbfaf7]">
          {keys.map((k) => {
            const state = keyState(k);
            return (
              <li key={k.id} className="flex items-center justify-between px-6 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink">{k.name}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide ${state.cls}`}
                    >
                      {state.label}
                    </span>
                  </div>
                  <div className="text-xs text-faint">
                    <span className="font-mono">{k.id}</span>
                    {k.scopes ? ` · ${k.scopes}` : ''}
                    {/* pinned UTC/en-US: these rows SSR from the `initial` prop
                        (home pre-traffic branch), and keys issued in-session
                        render client-side — one deterministic format keeps the
                        list coherent and hydration clean (React #418) */}
                    {k.createdAt ? ` · issued ${new Date(k.createdAt).toLocaleDateString('en-US', { timeZone: 'UTC' })}` : ''}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-4">
        <button
          onClick={issue}
          disabled={busy}
          className="bg-ink px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Issuing…' : live.length > 0 ? 'Issue another key' : 'Issue a serving key'}
        </button>
        {error && <span className="text-sm text-warn">{error}</span>}
      </div>

      <p className="text-xs leading-relaxed text-faint">
        Potion stores only a hash of each key, so a key can never be shown again after it is
        issued — not to you, and not to us. Lost one? Issue another; old keys keep working until
        you revoke them.
      </p>
    </div>
  );
}
