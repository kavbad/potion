'use client';

// /workload interactivity (SPEC §9 flow 2): paste JSONL or drop a file, POST
// to /api/workloads, render the cluster breakdown as a clean horizontal bar
// list (cluster, count, %).
import { useRef, useState } from 'react';
import type { WorkloadResponse } from '@/lib/types';

export function WorkloadUpload() {
  const [jsonl, setJsonl] = useState('');
  const [result, setResult] = useState<WorkloadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setJsonl(await file.text());
  }

  async function onAnalyze() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/workloads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonl }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setResult(body as WorkloadResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(false);
    }
  }

  const lineCount = jsonl.split('\n').filter((l) => l.trim() !== '').length;

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-line bg-panel px-8 py-8">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink">
            Prompts — one per line (JSONL)
          </span>
          <textarea
            value={jsonl}
            onChange={(e) => setJsonl(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={
              '{"prompt": "Write a python function that reverses a string"}\n' +
              '{"prompt": "Extract all invoice fields as JSON"}\n' +
              'Summarize this meeting transcript in three bullets'
            }
            className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-xs leading-relaxed text-ink focus:border-accent focus:outline-none"
          />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <button
            onClick={onAnalyze}
            disabled={busy || lineCount === 0}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Analyzing…' : `Analyze ${lineCount > 0 ? `${lineCount} prompts` : ''}`}
          </button>
          <span className="text-xs text-faint">or</span>
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-line bg-panel px-4 py-2 text-sm text-soft hover:text-ink"
          >
            Upload .jsonl file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.txt,.ndjson"
            className="hidden"
            onChange={onFile}
          />
          {error && <span className="text-sm text-warn">{error}</span>}
        </div>
      </div>

      {result && <ClusterBreakdown result={result} />}
    </div>
  );
}

function ClusterBreakdown({ result }: { result: WorkloadResponse }) {
  const rows = Object.entries(result.breakdown)
    .map(([clusterId, count]) => ({ clusterId, count, pct: count / result.total }))
    .sort((a, b) => b.count - a.count);
  const max = Math.max(...rows.map((r) => r.count));

  return (
    <div className="rounded-xl border border-line bg-panel px-8 py-8">
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="text-lg font-medium text-ink">
          {result.total} prompts → {rows.length} clusters
        </h2>
        <span className="text-xs text-faint">
          avg assignment confidence {(result.avgConfidence * 100).toFixed(1)}%
        </span>
      </div>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.clusterId} className="flex items-center gap-4">
            <span className="w-40 shrink-0 truncate font-mono text-xs text-soft">
              {r.clusterId}
            </span>
            <div className="h-5 flex-1 rounded bg-paper">
              <div
                className="h-5 rounded bg-accent opacity-80"
                style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }}
              />
            </div>
            <span className="w-24 shrink-0 text-right text-xs text-soft">
              {r.count} · {(r.pct * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-faint">
        Each cluster gets its own cost-quality frontier — see the Frontiers tab for the clusters
        that dominate your spend.
      </p>
    </div>
  );
}
