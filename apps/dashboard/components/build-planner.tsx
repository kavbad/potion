'use client';

// "WHAT ARE YOU BUILDING?" — the from-scratch flow (SERVING-ROADMAP S2).
//
// Describe it → we say what kind of workload it is (and what else it nearly
// was) → you say what matters most → we show the strategy that would actually
// serve you, with the measured numbers → one click creates the policy and key.
//
// The design pressure on this page is all in one direction: it is a
// first-impression surface, so every honest qualifier is something a demo
// would want removed. Three are deliberately load-bearing and must not be
// quietly dropped —
//
//   · the CLASSIFICATION CAVEAT. One sentence is thin evidence. When the
//     margin over the runner-up is small, this says so and offers the
//     runner-up, instead of presenting a confident-looking pick.
//   · the FULL FRONTIER. Every measured strategy is shown, not the three a
//     policy shape happens to select — those collapsed onto the same point
//     whenever the frontier was short, which both looked like a bug and hid
//     the trade-off the measurement paid for. See FrontierTable.
//   · the BASIS LINE. These are Potion's measurements of this workload TYPE,
//     not of the customer's traffic — a genuinely weaker claim than the
//     numbers elsewhere in the product, and it says so in plain words.
import { useState } from 'react';
import Link from 'next/link';
import { CopyBlock } from '@/components/copy-block';
import { FrontierTable } from '@/components/frontier-table';
import type { PlanResponse } from '@/lib/types';

/** Below this the winner is not meaningfully ahead of the runner-up. */
const NARROW_MARGIN = 0.1;
/** The assigner's own routing threshold — below it, serving says 'general'. */
const CONFIDENCE_FLOOR = 0.62;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: { message?: string } }).error?.message ?? res.statusText)
        : res.statusText;
    throw new Error(message);
  }
  return parsed as T;
}

export function BuildPlanner() {
  const [description, setDescription] = useState('');
  const [samplesText, setSamplesText] = useState('');
  const [showSamples, setShowSamples] = useState(false);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [chosen, setChosen] = useState<{ label: string; description: string } | null>(null);
  const [chosenHash, setChosenHash] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const samples = samplesText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);

  async function submitPlan() {
    setBusy(true);
    setError(null);
    setChosen(null);
    setChosenHash(null);
    setIssuedKey(null);
    try {
      setPlan(
        await postJson<PlanResponse>('/api/plan', {
          description: description.trim(),
          ...(samples.length > 0 ? { samples } : {}),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply(row: { policy: PlanResponse['frontier'][number]['policy']; strategy: string; strategyHash: string; description: string }) {
    setBusy(true);
    setError(null);
    try {
      const created = await postJson<{ apiKey?: string }>('/api/policies', {
        policy: row.policy,
        createKey: true,
      });
      setChosen({ label: row.strategy, description: row.description });
      setChosenHash(row.strategyHash);
      setIssuedKey(created.apiKey ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const narrow = plan !== null && plan.intent.margin < NARROW_MARGIN;
  const weak = plan !== null && plan.intent.cluster.confidence < CONFIDENCE_FLOOR;

  return (
    <div className="space-y-10">
      {/* ---- 1. the idea ---- */}
      <section className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-ink">What are you building?</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="A bot that reads support emails and pulls out the order number, issue and urgency"
            className="w-full rounded-lg border border-line bg-panel px-4 py-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </label>

        {showSamples ? (
          <label className="block">
            <span className="mb-2 block text-xs text-faint">
              Optional — paste two or three real prompts, one per line. Actual prompts are your
              workload; a description is a guess about it, so these decide the answer when they
              disagree.
            </span>
            <textarea
              value={samplesText}
              onChange={(e) => setSamplesText(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-line bg-panel px-4 py-3 font-mono text-xs text-ink focus:border-accent focus:outline-none"
            />
          </label>
        ) : (
          <button
            onClick={() => setShowSamples(true)}
            className="text-xs text-accent underline"
            type="button"
          >
            Add a few real prompts to sharpen this
          </button>
        )}

        <div className="flex items-center gap-4">
          <button
            onClick={() => void submitPlan()}
            disabled={busy || description.trim().length < 3}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy && !plan ? 'Working…' : 'Show me what to use'}
          </button>
          {error && <span className="text-sm text-warn">{error}</span>}
        </div>
      </section>

      {plan && (
        <>
          {/* ---- 2. what we think it is ---- */}
          <section className="space-y-4">
            <h2 className="text-sm font-medium text-ink">This looks like…</h2>
            <div className="rounded-xl border border-line bg-panel px-6 py-5">
              <div className="text-lg font-medium text-ink">{plan.intent.cluster.name}</div>
              <p className="mt-1 text-sm text-soft">{plan.intent.cluster.description}</p>

              {plan.intent.sampleBreakdown && (
                <p className="mt-3 text-xs text-faint">
                  Based on your {plan.intent.sampleCount} sample prompt
                  {plan.intent.sampleCount === 1 ? '' : 's'}:{' '}
                  {Object.entries(plan.intent.sampleBreakdown)
                    .map(([id, n]) => `${n}× ${id}`)
                    .join(', ')}
                  .
                </p>
              )}

              {(narrow || weak) && (
                <p className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                  {weak
                    ? 'This description does not match any workload type strongly. '
                    : 'This was a close call — the runner-up scored almost the same. '}
                  Adding a few real prompts above will settle it. Potion also re-classifies every
                  request at serve time, so the routing follows your actual traffic, not this guess.
                </p>
              )}

              {plan.intent.alternatives.length > 0 && (
                <p className="mt-3 text-xs text-faint">
                  Also considered:{' '}
                  {plan.intent.alternatives
                    .map((a) => `${a.name} (${a.confidence.toFixed(2)})`)
                    .join(', ')}{' '}
                  · chosen at {plan.intent.cluster.confidence.toFixed(2)}
                </p>
              )}
            </div>
          </section>

          {/* ---- 3. what matters most ---- */}
          {plan.evidence.measured && plan.evidence.evaluations > 0 && (
            <section className="rounded-xl border border-line bg-panel px-6 py-5">
              <p className="text-sm leading-relaxed text-soft">
                To answer this, Potion ran{' '}
                <span className="font-medium text-ink">
                  {plan.evidence.evaluations.toLocaleString()} live evaluations
                </span>{' '}
                for {plan.intent.cluster.name} —{' '}
                <span className="font-medium text-ink">{plan.evidence.strategies}</span> strategies
                across <span className="font-medium text-ink">{plan.evidence.items}</span> test items,
                each answer scored against a reference.
                {plan.evidence.dominatedAway !== null && plan.evidence.dominatedAway > 0 ? (
                  <>
                    {' '}
                    <span className="font-medium text-ink">{plan.evidence.dominatedAway}</span> of
                    those were beaten outright on every dimension and discarded; the{' '}
                    <span className="font-medium text-ink">{plan.evidence.pointCount}</span> below are
                    what survived.
                  </>
                ) : (
                  <>
                    {' '}
                    Only the{' '}
                    <span className="font-medium text-ink">{plan.evidence.pointCount}</span> that
                    nothing else beat outright are offered below.
                  </>
                )}
              </p>
              <p className="mt-2 text-xs text-faint">
                Frontier v{plan.evidence.frontierVersion} · {plan.evidence.provenance} provider
                evidence · you are seeing the same numbers the compiler uses.
                {!plan.evidence.countsAreComplete &&
                  ' Counts cover the strategies still on the frontier; candidates measured and then beaten are not included here.'}
              </p>
            </section>
          )}

          <section className="space-y-4">
            <h2 className="text-sm font-medium text-ink">What matters most to you?</h2>

            {!plan.evidence.measured ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-6 py-5 text-sm leading-relaxed text-amber-800">
                Potion has not measured this workload type on this deployment yet, so there is
                nothing honest to recommend. You can still connect and send traffic — requests will
                ride the default strategy and say so — but no model choice here would be backed by
                evidence.
              </div>
            ) : (
              <FrontierTable plan={plan} onApply={apply} busy={busy} chosenHash={chosenHash} />
            )}

            <p className="text-xs leading-relaxed text-faint">
              {plan.basis === 'platform-measured' ? (
                <>
                  These are Potion&apos;s own measurements of{' '}
                  <span className="font-medium text-soft">{plan.intent.cluster.name}</span> across
                  providers — {plan.evidence.pointCount} strategies on frontier v
                  {plan.evidence.frontierVersion}, {plan.evidence.provenance} evidence. They are
                  <span className="font-medium text-soft"> not</span> measurements of your traffic,
                  which does not exist yet. Once you send requests, Potion measures{' '}
                  <span className="font-medium text-soft">your</span> workload and the numbers
                  become yours.
                  {plan.evidence.latencySource === 'harness' && (
                    <>
                      {' '}
                      <span className="text-amber-700">*</span> Latency is the one number measured
                      differently: these come from evaluation runs (the model call only) rather than
                      from live requests end to end, so treat them as provisional and expect your
                      real p95 to include network and your own overhead. Potion switches to
                      serving-grade latency automatically once you have enough traffic.
                    </>
                  )}
                </>
              ) : (
                <>Nothing has been measured for this workload type on this deployment.</>
              )}
            </p>
          </section>

          {/* ---- 4. you are connected ---- */}
          {chosen && (
            <section className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 px-6 py-5">
              <h2 className="text-sm font-medium text-emerald-800">
                Done — Potion will serve you {chosen.label}. {chosen.description}
              </h2>
              {issuedKey && <CopyBlock label="Your Potion API key (shown once)" text={issuedKey} />}
              <p className="text-sm text-emerald-800">
                <Link href="/" className="font-medium underline">
                  Go to Connect &amp; auto-route
                </Link>{' '}
                for the endpoint and ready-to-paste snippets — and to watch your first requests get
                routed.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
