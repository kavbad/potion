'use client';

// THE FRONTIER LENS — type a prompt, watch Potion read it.
//
// The playground below lets you chat against frontier points you already
// chose. This is the missing front half: paste the prompt you actually have,
// and see what the COMPILER would see — which kind of work it reads as, how
// sure it is, what else it nearly was, and the measured frontier for that
// work with every real point on it. It is /api/plan (the same call behind
// the /build flow) with the prompt as a SAMPLE, so the classification is the
// serve path's classification, not a lookalike.
//
// Debounced hard (900ms, min 12 chars): every lens call runs the embedder.
// Pennies, but pennies on keystrokes multiply.
import { useEffect, useRef, useState } from 'react';
import { FrontierTable } from '@/components/frontier-table';
import type { PlanResponse } from '@/lib/types';

const DEBOUNCE_MS = 900;
const MIN_CHARS = 12;

export function FrontierLens() {
  const [prompt, setPrompt] = useState('');
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosenHash, setChosenHash] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const text = prompt.trim();
    if (text.length < MIN_CHARS) {
      setPlan(null);
      setError(null);
      return;
    }
    timer.current = setTimeout(() => {
      const mySeq = ++seq.current;
      setBusy(true);
      setError(null);
      void (async () => {
        try {
          const res = await fetch('/api/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ description: text.slice(0, 200), samples: [text] }),
          });
          const body: unknown = await res.json().catch(() => null);
          if (mySeq !== seq.current) return; // a newer keystroke superseded us
          if (!res.ok) {
            const msg =
              body && typeof body === 'object' && 'error' in body
                ? String((body as { error: { message?: string } }).error?.message ?? res.statusText)
                : res.statusText;
            setError(msg);
            setPlan(null);
            return;
          }
          setPlan(body as PlanResponse);
        } catch (e) {
          if (mySeq === seq.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (mySeq === seq.current) setBusy(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [prompt]);

  async function apply(row: {
    policy: PlanResponse['frontier'][number]['policy'];
    strategy: string;
    strategyHash: string;
    description: string;
  }): Promise<void> {
    setChosenHash(row.strategyHash);
    try {
      const res = await fetch('/api/policies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: row.policy, createKey: false }),
      });
      if (res.ok) setApplied(row.strategy);
      else setChosenHash(null);
    } catch {
      setChosenHash(null);
    }
  }

  return (
    <section className="mb-12 space-y-5">
      <div>
        <h2 className="text-sm font-medium text-ink">What would Potion do with this?</h2>
        <p className="mt-1 text-xs leading-relaxed text-faint">
          Paste a real prompt. You see exactly what the compiler sees — the kind of work it reads,
          and the measured frontier for it. Nothing is sent to a model; classification only.
        </p>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="Extract the invoice number, total and due date from the document below…"
        className="w-full rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
      />

      {busy && <p className="font-mono text-xs text-faint">reading…</p>}
      {error && <p className="text-sm text-warn">{error}</p>}

      {plan && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-xs text-faint">reads as</span>
            <span className="rounded bg-accent-soft px-2 py-0.5 font-mono text-sm font-medium text-accent">
              {plan.intent.cluster.clusterId}
            </span>
            <span className="font-mono text-xs text-faint">
              confidence {plan.intent.cluster.confidence.toFixed(2)}
            </span>
            {plan.intent.alternatives.length > 0 && (
              <span className="font-mono text-xs text-faint">
                · nearly:{' '}
                {plan.intent.alternatives
                  .slice(0, 2)
                  .map((a) => `${a.clusterId} (${a.confidence.toFixed(2)})`)
                  .join(', ')}
              </span>
            )}
          </div>

          {plan.evidence.measured ? (
            <FrontierTable plan={plan} onApply={apply} busy={false} chosenHash={chosenHash} />
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800">
              Nothing measured for this kind of work on this deployment yet — a request like this
              would ride the default strategy, and its receipt would say{' '}
              <code className="font-mono text-xs">fallback=1</code> rather than pretending.
            </p>
          )}

          {applied && (
            <p className="text-sm text-accent">
              Policy bound to {applied} — requests on your key now route with it.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
