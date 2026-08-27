'use client';

// ASK THE DOCS — the public docs page answering its own questions, through
// Potion. One input; the answer streams back from /api/docs-ask; the
// receipt line under it is Potion's x-frontier-trace (forwarded as
// x-potion-receipt), so a reader sees the product do the thing the page
// describes: the kind of work, the strategy, and whether the evidence was
// live. Nothing simulated — no receipt header, no receipt line.
import { useState } from 'react';

const EXAMPLES = [
  'What does the model field do?',
  'What does fallback=1 mean in the trace?',
  "How do I rebind a key's policy?",
];

/** Turn `cluster=…;strategy=…;…;provenance=…` into one readable line. */
function describeReceipt(raw: string): string {
  const kv = new Map<string, string>();
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) kv.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const cluster = kv.get('cluster') ?? '—';
  const strategy = kv.get('strategy') ?? '—';
  const provenance = kv.get('provenance') ?? '—';
  const fallback = kv.get('fallback') === '1' ? ' · fallback' : '';
  return `routed as ${cluster} · strategy ${strategy} · ${provenance}${fallback}`;
}

export function DocsAsk() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer('');
    setReceipt(null);
    setError(null);
    try {
      const res = await fetch('/api/docs-ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `request failed (${res.status})`);
        return;
      }
      setReceipt(res.headers.get('x-potion-receipt'));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setAnswer(acc);
      }
      acc += decoder.decode();
      setAnswer(acc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7]">
      <div className="border-b border-[#d9d5cb] px-4 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
        ask the docs · answered from this page only · served through potion
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        className="flex items-center gap-3 border-b border-[#d9d5cb] px-4 py-3"
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          placeholder="Ask something this page should answer"
          aria-label="Ask the docs"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || question.trim().length === 0}
          className="shrink-0 bg-ink px-3 py-1 font-mono text-[12px] text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'asking' : 'ask'}
        </button>
      </form>
      <div className="flex flex-wrap gap-2 border-b border-[#d9d5cb] px-4 py-2.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={busy}
            onClick={() => {
              setQuestion(ex);
              void ask(ex);
            }}
            className="border border-[#d9d5cb] px-3 py-1 text-left text-xs text-soft transition-colors hover:border-ink hover:text-ink disabled:opacity-50"
          >
            {ex}
          </button>
        ))}
      </div>
      {(answer || error || busy) && (
        <div className="border-b border-[#d9d5cb] px-4 py-3">
          {error ? (
            <p className="text-sm leading-relaxed text-warn">{error}</p>
          ) : answer ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{answer}</p>
          ) : (
            <p className="font-mono text-[12px] text-faint">waiting for the first token</p>
          )}
        </div>
      )}
      <p className="px-4 py-2 font-mono text-[11.5px] text-faint">
        {receipt ? describeReceipt(receipt) : 'the receipt — x-frontier-trace, forwarded as x-potion-receipt — appears here'}
      </p>
    </div>
  );
}
