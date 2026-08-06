'use client';

// Share links (M4 #31): mint a read-only public link for a frontier or a
// savings report, copy it, list the org's existing links, revoke (admin).
// The raw token is returned ONCE at mint time — the list can only show the
// masked hash prefix, so the fresh URL is surfaced in a CopyBlock right away.
import { useCallback, useEffect, useState } from 'react';
import { CopyBlock } from './copy-block';

export interface ShareTokenDto {
  id: string;
  kind: 'frontier' | 'report';
  payload: Record<string, unknown>;
  redactNames: boolean;
  tokenHashPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}

interface MintResponse {
  id: string;
  kind: 'frontier' | 'report';
  token: string;
  url: string;
  createdAt: string;
}

export function SharePanel({
  kind,
  clusterId,
  windowDays,
}: {
  kind: 'frontier' | 'report';
  clusterId?: string;
  windowDays?: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<MintResponse | null>(null);
  const [tokens, setTokens] = useState<ShareTokenDto[] | null>(null);
  const [role, setRole] = useState<string>('viewer');

  const load = useCallback(async () => {
    const [meRes, listRes] = await Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null),
      fetch('/api/share', { cache: 'no-store' }).catch(() => null),
    ]);
    if (meRes?.ok) {
      const me = (await meRes.json()) as { role?: string };
      setRole(me.role ?? 'viewer');
    }
    if (listRes?.ok) {
      const body = (await listRes.json()) as { tokens: ShareTokenDto[] };
      setTokens(body.tokens.filter((t) => t.kind === kind));
    }
  }, [kind]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function mint() {
    setBusy(true);
    setError(null);
    setFresh(null);
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          ...(kind === 'frontier' ? { clusterId } : { windowDays }),
        }),
      });
      const body = (await res.json()) as MintResponse & {
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(body.error?.message ?? `mint failed (${res.status})`);
      } else {
        setFresh(body);
        void load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/share/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
    if (res.ok) void load();
  }

  const absolute = (path: string): string =>
    typeof window === 'undefined' ? path : `${window.location.origin}${path}`;

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full border border-line bg-panel px-4 py-1.5 text-sm text-soft transition-colors hover:text-ink"
      >
        Share ↗
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-[26rem] rounded-xl border border-line bg-panel p-5 shadow-lg">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-medium text-ink">
              Share this {kind === 'frontier' ? 'frontier' : 'report'}
            </h3>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-faint hover:text-ink">
              Close
            </button>
          </div>
          <p className="mb-4 text-xs leading-relaxed text-soft">
            Anyone with the link sees a read-only{' '}
            {kind === 'frontier' ? 'frontier' : 'savings report'} — no sign-in required. Org name
            is redacted by default; simulated points stay
            badged SIMULATED. Links can be revoked at any time.
          </p>
          <button
            type="button"
            onClick={() => void mint()}
            disabled={busy}
            className="mb-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create link'}
          </button>
          {error ? <p className="mb-3 text-xs text-warn">{error}</p> : null}
          {fresh ? (
            <div className="mb-4">
              <CopyBlock label="New link — shown once, copy it now" text={absolute(fresh.url)} />
            </div>
          ) : null}
          {tokens && tokens.length > 0 ? (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {tokens.map((t) => (
                <li key={t.id} className="flex items-center justify-between px-3 py-2 text-xs">
                  <span className="font-mono text-soft">
                    st_…{t.tokenHashPrefix}
                    <span className="ml-2 text-faint">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  {t.revokedAt ? (
                    <span className="text-faint">revoked</span>
                  ) : role === 'admin' ? (
                    <button
                      type="button"
                      onClick={() => void revoke(t.id)}
                      className="rounded border border-line px-2 py-0.5 text-soft hover:text-ink"
                    >
                      Revoke
                    </button>
                  ) : (
                    <span className="text-faint">active</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
