'use client';

// /policy interactivity (SPEC §9 flow 4): four policy cards → POST
// /api/policies (creates a fresh api key bound to the policy) → show the
// endpoint URL + curl / openai-node snippets from /api/endpoint-snippet.
import { useState } from 'react';
import { CopyBlock } from '@/components/copy-block';
import type { Policy, PolicyResponse, SnippetResponse } from '@/lib/types';

type PolicyKind = Policy['type'];

const CARDS: Array<{
  kind: PolicyKind;
  title: string;
  blurb: string;
}> = [
  {
    kind: 'max_quality',
    title: 'Best quality',
    blurb: 'Always pick the highest-quality strategy that fits under a cost ceiling.',
  },
  {
    kind: 'min_cost',
    title: 'Lowest cost',
    blurb: 'Pick the cheapest strategy that still clears a quality floor.',
  },
  {
    kind: 'latency_bound',
    title: 'Fastest under a deadline',
    blurb: 'Best quality among strategies whose p95 latency fits your budget.',
  },
  {
    kind: 'compound',
    title: 'Both: floor and deadline',
    blurb:
      'Cheapest strategy that clears your quality floor AND fits your p95 budget. ' +
      'The deadline is a hard limit — anything slower is excluded, not discounted — ' +
      'so we show you what that limit costs and what relaxing it would save.',
  },
];

export function PolicyPicker() {
  const [kind, setKind] = useState<PolicyKind>('max_quality');
  const [ceiling, setCeiling] = useState('1.00');
  const [floor, setFloor] = useState(0.8);
  const [p95, setP95] = useState('1000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PolicyResponse | null>(null);
  const [snippet, setSnippet] = useState<SnippetResponse | null>(null);

  function policy(): Policy {
    switch (kind) {
      case 'max_quality':
        return { type: 'max_quality', costCeilingPer1K: Number(ceiling) };
      case 'min_cost':
        return { type: 'min_cost', qualityFloor: floor };
      case 'latency_bound':
        return { type: 'latency_bound', p95Ms: Number(p95) };
      case 'compound':
        return { type: 'compound', qualityFloor: floor, p95Ms: Number(p95) };
    }
  }

  async function onApply() {
    setBusy(true);
    setError(null);
    setCreated(null);
    setSnippet(null);
    const p = policy();
    try {
      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: p, createKey: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setCreated(body as PolicyResponse);
      const snipRes = await fetch(
        `/api/endpoint-snippet?policy=${encodeURIComponent(JSON.stringify(p))}`,
      );
      const snipBody = await snipRes.json();
      if (snipRes.ok) setSnippet(snipBody as SnippetResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none';

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {CARDS.map((card) => {
          const active = kind === card.kind;
          return (
            <button
              key={card.kind}
              onClick={() => setKind(card.kind)}
              className={`rounded-xl border p-6 text-left transition-colors ${
                active ? 'border-accent bg-panel' : 'border-line bg-panel hover:border-faint'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-sm font-medium ${active ? 'text-accent' : 'text-ink'}`}>
                  {card.title}
                </span>
                <span
                  className={`h-3 w-3 rounded-full border-2 ${
                    active ? 'border-accent bg-accent' : 'border-line'
                  }`}
                />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-soft">{card.blurb}</p>

              <div className="mt-4" onClick={(e) => e.stopPropagation()}>
                {card.kind === 'max_quality' && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-faint">
                      Cost ceiling ($ per 1K requests)
                    </span>
                    <input
                      type="number"
                      min="0.001"
                      step="0.1"
                      value={ceiling}
                      onChange={(e) => setCeiling(e.target.value)}
                      disabled={!active}
                      className={inputCls}
                    />
                  </label>
                )}
                {card.kind === 'min_cost' && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-faint">
                      Quality floor — {floor.toFixed(2)}
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={floor}
                      onChange={(e) => setFloor(Number(e.target.value))}
                      disabled={!active}
                      className="w-full accent-accent"
                    />
                  </label>
                )}
                {(card.kind === 'latency_bound' || card.kind === 'compound') && (
                  <label className="block">
                    <span className="mb-1 block text-xs text-faint">p95 budget (ms)</span>
                    <input
                      type="number"
                      min="1"
                      step="100"
                      value={p95}
                      onChange={(e) => setP95(e.target.value)}
                      disabled={!active}
                      className={inputCls}
                    />
                  </label>
                )}
                {card.kind === 'compound' && (
                  <label className="mt-2 block">
                    <span className="mb-1 block text-xs text-faint">
                      Quality floor — {floor.toFixed(2)}
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={floor}
                      onChange={(e) => setFloor(Number(e.target.value))}
                      disabled={!active}
                      className="w-full accent-accent"
                    />
                  </label>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={onApply}
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Applying…' : 'Apply policy & create API key'}
        </button>
        {error && <span className="text-sm text-warn">{error}</span>}
      </div>

      {created && (
        <div className="space-y-6 rounded-xl border border-line bg-panel px-8 py-8">
          <div>
            <h2 className="text-lg font-medium text-ink">Policy live</h2>
            <p className="mt-1 text-sm text-soft">
              <span className="font-mono text-xs">{created.policy.id}</span> is bound to a fresh
              API key. Save the key now — it is shown exactly once.
            </p>
          </div>

          {created.apiKey && <CopyBlock label="Your Potion API key (shown once)" text={created.apiKey} />}

          {snippet && (
            <>
              <CopyBlock label="Endpoint" text={snippet.url} />
              <CopyBlock label="curl" text={snippet.curl} />
              <CopyBlock label="Node.js (openai SDK)" text={snippet.openaiNode} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
