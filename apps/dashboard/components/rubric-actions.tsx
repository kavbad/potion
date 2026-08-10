'use client';

// Rubric review actions (G1.5): admin-only client islands on /rubrics.
// Rendered only for admins (the page gates on /api/auth/me); the API
// enforces the role again server-side — a forged click gets a 403.
// Reject REQUIRES a reason: rejected rubrics stay listed with their reason.
import { useRouter } from 'next/navigation';
import { useState } from 'react';

function useAction(): {
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<Response>) => Promise<void>;
} {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<Response>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'action failed');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const btn =
  'rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-medium text-soft transition-colors hover:text-ink disabled:opacity-50';

export function RubricReviewButtons({ id }: { id: string }) {
  const { busy, error, run } = useAction();
  const [reason, setReason] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(() => fetch(`/api/rubrics/${encodeURIComponent(id)}/approve`, { method: 'POST' }))
        }
        className={btn}
      >
        {busy ? 'Working…' : 'Approve (put in force)'}
      </button>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="rejection reason (required)"
        className="w-56 rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink"
      />
      <button
        type="button"
        disabled={busy || reason.trim().length < 3}
        onClick={() =>
          void run(() =>
            fetch(`/api/rubrics/${encodeURIComponent(id)}/reject`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reason: reason.trim() }),
            }),
          )
        }
        className={btn}
      >
        Reject
      </button>
      {error ? <span className="text-xs text-warn">{error}</span> : null}
    </div>
  );
}

export function RubricGenerateButton({ clusterId }: { clusterId: string }) {
  const { busy, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(() =>
            fetch('/api/rubrics/generate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ clusterId }),
            }),
          )
        }
        className={btn}
      >
        {busy ? 'Generating…' : 'Generate rubric'}
      </button>
      {error ? <span className="text-xs text-warn">{error}</span> : null}
    </span>
  );
}

export function CertifyButton({ clusterId }: { clusterId: string }) {
  const { busy, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(() =>
            fetch('/api/certifications/run', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ clusterId }),
            }),
          )
        }
        className={btn}
      >
        {busy ? 'Certifying…' : 'Certify suite'}
      </button>
      {error ? <span className="text-xs text-warn">{error}</span> : null}
    </span>
  );
}
