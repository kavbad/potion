'use client';

// TRY A REQUEST — the playground folded into Home (operator, 2026-08-22:
// the product optimizes for key → use it → see the value; a separate
// Playground page was a detour). One box: type a prompt, it goes through
// the REAL serving path under your bound policy (potion-auto), the answer
// streams back, and the receipt shows what ran and why. Nothing simulated:
// provenance is badged straight from the server's meta chunk.
import { useState } from 'react';

export type Rule = 'policy' | 'cost' | 'quality' | 'latency';
export interface Alternative { rule: 'cost' | 'quality' | 'latency'; model: string | null; strategy_hash: string | null; quality: number | null; cost_per_1k: number | null; p95_ms: number | null }
export interface Receipt {
  clusterId: string | null;
  clusterConfidence: number | null;
  strategyHash: string | null;
  model: string | null;
  quality: number | null;
  costPer1K: number | null;
  p95Ms: number | null;
  rule: Rule;
  floor: number | null;
  alternatives: Alternative[];
  provenance: string | null;
  costUsd: number | null;
  latencyMs: number | null;
}

function* sseObjects(frame: string): Generator<Record<string, unknown>> {
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      yield JSON.parse(payload) as Record<string, unknown>;
    } catch {
      /* partial frame */
    }
  }
}

const EXAMPLES = [
  'Is this review positive, negative, or neutral? "Crashed twice, support never replied."',
  'Write a function that merges overlapping date ranges, exclusive of endpoints.',
  'Extract the order number, issue, and urgency from: "Order 4471 arrived broken, need a replacement before Friday."',
];

const RULES: { rule: Rule; label: string; hint: string }[] = [
  { rule: 'policy', label: 'your rule', hint: 'the rule bound to your key' },
  { rule: 'cost', label: 'cost', hint: 'cheapest at or above your floor' },
  { rule: 'quality', label: 'quality', hint: 'highest measured quality' },
  { rule: 'latency', label: 'latency', hint: 'fastest at or above your floor' },
];

function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function TryRequest({ onReceipt }: { onReceipt?: (r: Receipt) => void } = {}) {
  const [rule, setRule] = useState<Rule>('policy');
  const [lastPrompt, setLastPrompt] = useState('');
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(text: string, withRule: Rule = rule) {
    const p = text.trim();
    if (!p || busy) return;
    setLastPrompt(p);
    setBusy(true);
    setAnswer('');
    setReceipt(null);
    setError(null);
    try {
      const res = await fetch('/api/playground/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clusterId: 'auto', auto: true, ...(withRule !== 'policy' ? { optimizeFor: withRule } : {}), messages: [{ role: 'user', content: p }] }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `request failed (${res.status})`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const obj of sseObjects(frame)) {
            const choices = obj.choices as { delta?: { content?: string } }[] | undefined;
            if (choices && choices.length > 0) {
              const c = choices[0]?.delta?.content;
              if (c) {
                acc += c;
                setAnswer(acc);
              }
            } else if (obj.usage) {
              const r: Receipt = {
                clusterId: typeof obj.cluster_id === 'string' ? obj.cluster_id : null,
                clusterConfidence: typeof obj.cluster_confidence === 'number' ? obj.cluster_confidence : null,
                strategyHash: typeof obj.strategy_hash === 'string' ? obj.strategy_hash : null,
                model: typeof obj.model === 'string' ? obj.model : null,
                quality: typeof obj.quality === 'number' ? obj.quality : null,
                costPer1K: typeof obj.cost_per_1k === 'number' ? obj.cost_per_1k : null,
                p95Ms: typeof obj.p95_ms === 'number' ? obj.p95_ms : null,
                rule: (typeof obj.rule === 'string' ? obj.rule : 'policy') as Rule,
                floor: typeof obj.floor === 'number' ? obj.floor : null,
                alternatives: Array.isArray(obj.alternatives) ? (obj.alternatives as Alternative[]) : [],
                provenance: typeof obj.provenance === 'string' ? obj.provenance : null,
                costUsd: typeof obj.cost_usd === 'number' ? obj.cost_usd : null,
                latencyMs: typeof obj.latency_ms === 'number' ? obj.latency_ms : null,
              };
              setReceipt(r);
              onReceipt?.(r);
            } else if (obj.error) {
              setError((obj.error as { message?: string }).message ?? 'stream error');
            }
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden border border-[#d9d5cb] bg-[#fbfaf7]">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
        <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-accent/70" />
        try a request · routed under your policy · receipt attached
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#d9d5cb] px-5 py-2.5 font-mono text-[11px]">
        <span className="uppercase tracking-[0.14em] text-faint">optimize for</span>
        <div className="flex divide-x divide-[#d9d5cb] border border-[#d9d5cb]">
          {RULES.map((r) => (
            <button
              key={r.rule}
              type="button"
              title={r.hint}
              disabled={busy}
              onClick={() => {
                setRule(r.rule);
                if (lastPrompt) void send(lastPrompt, r.rule);
              }}
              className={`px-3 py-1 transition-colors ${rule === r.rule ? 'bg-ink text-[#f4f2ec]' : 'text-soft hover:text-ink'} disabled:opacity-50`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-faint">{RULES.find((r) => r.rule === rule)?.hint}{lastPrompt ? ' · switching re-runs your last request' : ''}</span>
      </div>
      <div className="flex items-start gap-3 border-b border-line px-5 py-4">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(prompt);
          }}
          rows={2}
          placeholder="Type any request — or pick an example below. ⌘↵ to send."
          className="min-w-0 flex-1 resize-none bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none"
        />
        <button
          onClick={() => void send(prompt)}
          disabled={busy || prompt.trim().length === 0}
          aria-label="Route it"
          className="flex h-9 w-9 shrink-0 items-center justify-center bg-ink text-white transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {busy ? <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border border-white/50 border-t-white" /> : '↑'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => {
              setPrompt(ex);
              void send(ex);
            }}
            disabled={busy}
            className="border border-[#d9d5cb] px-3 py-1 text-left text-xs text-soft transition-colors hover:border-ink hover:text-ink disabled:opacity-50"
          >
            {ex.length > 64 ? `${ex.slice(0, 64)}…` : ex}
          </button>
        ))}
      </div>
      <div className="grid lg:grid-cols-[15rem_1fr]">
        <div className="border-b border-line px-5 py-5 lg:border-b-0 lg:border-r">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">receipt</div>
          {receipt ? (
            <dl className="mt-4 space-y-3.5 font-mono text-xs">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">kind of work</dt>
                <dd className="mt-1 text-ink">
                  {receipt.clusterId ?? '—'}
                  {receipt.clusterConfidence !== null && <span className="ml-1 text-faint">{receipt.clusterConfidence.toFixed(2)}</span>}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">routed to</dt>
                <dd className="mt-1 break-all text-[13px] text-accent">{receipt.model ?? (receipt.strategyHash ? receipt.strategyHash.slice(0, 8) : '—')}</dd>
                {receipt.quality !== null && (
                  <dd className="mt-0.5 text-soft">scores {receipt.quality.toFixed(2)} on this kind of work{receipt.floor !== null ? ` · floor ${receipt.floor.toFixed(2)}` : ''}</dd>
                )}
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">this request</dt>
                <dd className="mt-1 text-soft">
                  {receipt.costUsd !== null ? `$${receipt.costUsd.toFixed(5)}` : '—'} · {receipt.latencyMs !== null ? `${Math.round(receipt.latencyMs)} ms` : '—'}
                  {receipt.costPer1K !== null ? ` · ${usd(receipt.costPer1K)} per 1k` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-faint">rule · evidence</dt>
                <dd className="mt-1 text-soft">
                  {receipt.rule === 'policy' ? 'your rule' : `optimize for ${receipt.rule}`} · <span className={receipt.provenance === 'live' ? 'text-accent' : 'text-warn'}>{receipt.provenance ?? '—'}</span>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 font-mono text-xs leading-relaxed text-soft">
              the same routing your API key gets — what ran, and why, appears here
            </p>
          )}
        </div>
        <div className="min-w-0 px-5 py-5">
          {error ? (
            <p className="text-sm leading-relaxed text-warn">{error}</p>
          ) : answer ? (
            <div>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">{answer}</pre>
              {receipt && receipt.alternatives.length > 0 && (
                <div className="mt-6 border-t border-[#d9d5cb] pt-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                    what each rule picks for {receipt.clusterId ?? 'this kind of work'} · measured, click one to re-run
                  </div>
                  <table className="mt-2 w-full font-mono text-[11px]">
                    <thead className="text-[10px] uppercase tracking-wide text-faint">
                      <tr><th className="py-1 text-left font-normal">rule</th><th className="py-1 text-left font-normal">model</th><th className="py-1 text-right font-normal">quality</th><th className="py-1 text-right font-normal">$ / 1k</th><th className="py-1 text-right font-normal">p95</th></tr>
                    </thead>
                    <tbody>
                      {receipt.alternatives.map((a) => {
                        const active = receipt.strategyHash !== null && a.strategy_hash === receipt.strategyHash;
                        return (
                          <tr key={a.rule} onClick={() => { if (!busy && lastPrompt) { setRule(a.rule); void send(lastPrompt, a.rule); } }} className={`cursor-pointer border-t border-[#ebe8e0] ${active ? 'text-ink' : 'text-soft hover:text-ink'}`}>
                            <td className="py-1.5">{active ? '→ ' : ''}{a.rule}</td>
                            <td className="py-1.5 break-all">{a.model ?? '—'}</td>
                            <td className="py-1.5 text-right">{a.quality !== null ? a.quality.toFixed(2) : '—'}</td>
                            <td className="py-1.5 text-right">{a.cost_per_1k !== null ? usd(a.cost_per_1k) : '—'}</td>
                            <td className="py-1.5 text-right">{a.p95_ms !== null ? `${Math.round(a.p95_ms)} ms` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm leading-relaxed text-faint">
              Potion reads the request, picks the cheapest measured option your policy allows, and answers — with a receipt. Try one.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
