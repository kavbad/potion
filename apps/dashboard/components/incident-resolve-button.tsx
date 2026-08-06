'use client';

// Resolve-incident action (M3 #22): admin-only client island on the
// /reports incidents table. POSTs through the dashboard proxy route and
// refreshes the server-rendered table; resolving a rollback incident lifts
// the operating-point override (policy routing resumes).
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function IncidentResolveButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onResolve(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/incidents/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'resolve failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void onResolve()}
        disabled={busy}
        className="rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-medium text-soft transition-colors hover:text-ink disabled:opacity-50"
      >
        {busy ? 'Resolving…' : 'Resolve'}
      </button>
      {error ? <span className="text-xs text-warn">{error}</span> : null}
    </span>
  );
}
