'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ProviderId } from '@/lib/types';

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'mock', label: 'Mock (demo)' },
];

export function KeysForm() {
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg: string }>({
    kind: 'idle',
    msg: '',
  });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'busy', msg: 'Storing…' });
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setStatus({
        kind: 'ok',
        msg: body.servingEnabled
          ? `Stored as ${body.maskedKey} — encrypted at rest and now serving your org.`
          : `Stored as ${body.maskedKey} — encrypted at rest.`,
      });
      setApiKey('');
      setName('');
      router.refresh(); // re-render the server-side masked list
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'failed' });
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Provider</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-soft">Label (optional)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="prod anthropic"
            className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-soft">API key</span>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          type="password"
          required
          minLength={8}
          placeholder="sk-ant-…"
          autoComplete="off"
          className="w-full rounded-md border border-line bg-panel px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
        />
      </label>
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={status.kind === 'busy'}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Connect key
        </button>
        {status.kind !== 'idle' && (
          <span className={`text-sm ${status.kind === 'err' ? 'text-warn' : 'text-soft'}`}>
            {status.msg}
          </span>
        )}
      </div>
    </form>
  );
}
