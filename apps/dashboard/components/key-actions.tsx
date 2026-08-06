'use client';

// Per-key lifecycle actions (M2 Wave 2, ROADMAP #16): validate / rotate /
// revoke + the custody audit trail. Client island on the connect-keys page;
// every action round-trips through the dashboard's proxy routes and then
// refreshes the server-rendered list.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { KeyAuditEntryDto, KeyAuditResponse, ProviderKeyStatus } from '@/lib/types';

interface Props {
  id: string;
  status: ProviderKeyStatus;
}

async function post(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const message =
      (json?.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json ?? {};
}

export function KeyActions({ id, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [audit, setAudit] = useState<KeyAuditEntryDto[] | null>(null);

  async function run(action: string, fn: () => Promise<Record<string, unknown>>, ok: (b: Record<string, unknown>) => string) {
    setBusy(true);
    setNote(null);
    try {
      const body = await fn();
      setNote({ kind: 'ok', msg: ok(body) });
      router.refresh();
    } catch (err) {
      setNote({ kind: 'err', msg: err instanceof Error ? err.message : `${action} failed` });
    } finally {
      setBusy(false);
    }
  }

  const onValidate = () =>
    run('validate', () => post(`/api/keys/${id}/validate`), (b) =>
      `Validated ✓ (${String(b.modelVersion ?? 'ok')}, ${String(b.latencyMs ?? '?')}ms)`,
    );

  const onRotate = () => {
    const apiKey = window.prompt(
      'Paste the NEW raw provider key. It replaces the current material immediately (old key should be revoked at the provider).',
    );
    if (!apiKey) return;
    void run('rotate', () => post(`/api/keys/${id}/rotate`, { apiKey }), (b) =>
      `Rotated to key version ${String(b.keyVersion ?? '?')} — serving now uses the new key.`,
    );
  };

  const onRevoke = () => {
    if (!window.confirm('Revoke this key? Serving with it stops immediately.')) return;
    void run('revoke', () => post(`/api/keys/${id}/revoke`), () => 'Revoked — serving stopped.');
  };

  const onToggleAudit = async () => {
    if (audit !== null) {
      setAudit(null);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/keys/${id}/audit`);
      const body = (await res.json()) as KeyAuditResponse;
      setAudit(body.audit ?? []);
    } catch {
      setNote({ kind: 'err', msg: 'audit fetch failed' });
    } finally {
      setBusy(false);
    }
  };

  const btn =
    'rounded-md border border-line bg-paper px-2.5 py-1 text-xs font-medium text-soft transition-colors hover:border-accent hover:text-ink disabled:opacity-50';

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {status === 'active' && (
          <>
            <button type="button" className={btn} disabled={busy} onClick={() => void onValidate()}>
              Validate
            </button>
            <button type="button" className={btn} disabled={busy} onClick={onRotate}>
              Rotate
            </button>
            <button type="button" className={btn} disabled={busy} onClick={onRevoke}>
              Revoke
            </button>
          </>
        )}
        <button type="button" className={btn} disabled={busy} onClick={() => void onToggleAudit()}>
          {audit === null ? 'Audit trail' : 'Hide audit'}
        </button>
        {note && (
          <span className={`text-xs ${note.kind === 'err' ? 'text-warn' : 'text-soft'}`}>
            {note.msg}
          </span>
        )}
      </div>
      {audit !== null && (
        <div className="rounded-md border border-line bg-paper px-3 py-2">
          {audit.length === 0 ? (
            <p className="text-xs text-faint">No custody events yet.</p>
          ) : (
            <ul className="space-y-1">
              {audit.map((a) => (
                <li key={a.id} className="flex items-baseline gap-2 text-xs">
                  <span className="font-mono text-faint">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                  <span className="font-medium capitalize text-ink">{a.action}</span>
                  <span className="text-soft">{a.actor}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
