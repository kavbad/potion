'use client';

// M5 (#36): admin islands for the traces page — run clustering + set retention.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { postOrThrow } from '@/lib/post';

export function TraceClusterButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setResult(null);
          setError(null);
          try {
            await postOrThrow('/api/traces/cluster', {});
            setResult('cluster job enqueued — agent clusters appear below as it completes');
            router.refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'cluster failed');
          } finally {
            setPending(false);
          }
        }}
        className="rounded-md border border-accent/50 px-3 py-1.5 text-sm text-accent transition hover:bg-accent/10 disabled:opacity-50"
      >
        {pending ? 'Enqueuing…' : 'Cluster my traces'}
      </button>
      {result ? <span className="text-xs text-ink-soft">{result}</span> : null}
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </div>
  );
}

export function TraceRetentionForm({ current }: { current: number }) {
  const router = useRouter();
  const [days, setDays] = useState(String(current));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setMessage(null);
        setError(null);
        try {
          const res = await fetch('/api/traces/retention', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ days: Number(days) }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
            throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
          }
          setMessage(`retention set to ${days} day(s)`);
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'update failed');
        } finally {
          setPending(false);
        }
      }}
    >
      <label htmlFor="retention-days" className="text-xs text-ink-soft">
        Retention days
      </label>
      <input
        id="retention-days"
        type="number"
        min={0}
        max={3650}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        className="w-20 rounded-md border border-line bg-panel px-2 py-1 text-sm text-ink"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-line px-3 py-1.5 text-sm text-ink transition hover:border-accent disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
      {message ? <span className="text-xs text-good">{message}</span> : null}
      {error ? <span className="text-xs text-bad">{error}</span> : null}
    </form>
  );
}
