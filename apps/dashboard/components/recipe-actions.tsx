'use client';

// Recipe actions (M4b #37): admin-only client islands on /recipes.
//  - RecipeEvaluateButton: per-row POST /api/recipes/:hash/evaluate → 202
//    (enqueues a single-recipe research cycle; the library row updates when
//    the worker completes it).
//  - ResearchScanButton: POST /api/research/scan → 202 (diffs the model
//    catalog for new models; cycles appear in the cycles strip).
// Both go through the dashboard proxy routes and refresh the SSR table.
// Rendered only for admins (the page gates on /api/auth/me); the API
// enforces the role again server-side — a forged click gets a 403.
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export async function postOrThrow(url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as {
      error?: { message?: string } | string;
      message?: string;
    } | null;
    const message =
      typeof parsed?.error === 'object'
        ? parsed.error.message
        : typeof parsed?.error === 'string'
          ? parsed.message
          : undefined;
    throw new Error(message ?? `HTTP ${res.status}`);
  }
}

export function RecipeEvaluateButton({ hash }: { hash: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onEvaluate(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      await postOrThrow(`/api/recipes/${encodeURIComponent(hash)}/evaluate`);
      setNote('queued');
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void onEvaluate()}
        disabled={busy}
        className="rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-medium text-soft transition-colors hover:text-ink disabled:opacity-50"
      >
        {busy ? 'Queuing…' : 'Evaluate'}
      </button>
      {note ? <span className="text-xs text-faint">{note}</span> : null}
    </span>
  );
}

export function ResearchScanButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onScan(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      await postOrThrow('/api/research/scan', {});
      setNote('scan queued — cycles appear below as they complete');
      router.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => void onScan()}
        disabled={busy}
        className="rounded-md border border-line bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:opacity-80 disabled:opacity-50"
      >
        {busy ? 'Queuing…' : 'Scan for new models'}
      </button>
      {note ? <span className="text-xs text-faint">{note}</span> : null}
    </span>
  );
}
