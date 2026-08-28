'use client';

// FIRST RUN, redesigned (S1, brief v4): four quiet beats on one rail, ending
// with the product's one moment of theater — the first receipt, printing.
// There is no dashboard until this flow has generated something to put on
// it, so Today never opens empty.
//
//   1 · one question (what do you use today?) + consent — unchanged content
//   2 · your key, minted in place; the base URL beside it
//   3 · send one request (or use a sample)
//   4 · the receipt prints → "Go to Today", which opens with it
//
// Standing rules kept: the gate is session-users-only, fails OPEN on flaky
// reads, and the API is never gated. Non-admins (who cannot mint) finish at
// beat 1, exactly like the old gate. Every beat after 1 offers a quiet
// "skip for now" — the QUESTION is the only mandatory part (operator
// directive), the rest is a running start.
import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Mark } from '@/components/mark';
import { ReceiptCard } from '@/components/primitives';
import { routeOnce, type Receipt } from '@/components/try-request';
import { priceVsBaseline } from '@/lib/price-words';

const CHOICES: Array<{ key: string; label: string; sub: string; models: string[]; other: string | null }> = [
  { key: 'openai', label: 'OpenAI', sub: 'GPT models', models: ['or-gpt-full'], other: null },
  { key: 'anthropic', label: 'Anthropic', sub: 'Claude models', models: ['or-sonnet'], other: null },
  { key: 'google', label: 'Google', sub: 'Gemini models', models: ['or-gemini-flash'], other: null },
  { key: 'unsure', label: 'Several / not sure', sub: 'Use smart defaults', models: [], other: 'several or unsure — smart defaults' },
  { key: 'scratch', label: 'Building from scratch', sub: 'No AI in production yet', models: [], other: 'building from scratch' },
];

interface InterpretResponse {
  summary: string;
  mix: Array<{ clusterId: string; share: number }>;
  router: { name: string; version: number; provisional: boolean };
  assignments: Array<{ clusterId: string; share: number; label: string; quality: number | null; costPer1K: number | null }>;
  expected: {
    quality: number;
    costPer1K: number;
    baselineCostPer1K: number;
    baselineQuality?: number;
    savingsPct: number;
    incumbent?: { model: string; quality: number; costPer1K: number; coverage: number } | null;
  } | null;
}

const SAMPLE = 'Is this review positive, negative, or neutral? "Crashed twice, support never replied."';

export const FIRST_RECEIPT_KEY = 'potion:first-receipt';

type Beat = 'checking' | 'question' | 'reveal' | 'key' | 'try' | 'printed' | 'done';

export function FirstRunGate() {
  const pathname = usePathname();
  const [beat, setBeat] = useState<Beat>('checking');
  const [choice, setChoice] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [interp, setInterp] = useState<InterpretResponse | null>(null);
  const [consent, setConsent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // beat 2
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [router, setRouter] = useState<{ name: string; version: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // beats 3–4
  const [prompt, setPrompt] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const check = useCallback(async () => {
    const [me, inc] = await Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null),
      fetch('/api/incumbents', { cache: 'no-store' }).catch(() => null),
    ]);
    if (!me?.ok) return setBeat('done');
    const meBody = (await me.json()) as { user?: unknown; kind?: string; role?: string };
    if (!meBody.user || meBody.kind !== 'session') return setBeat('done');
    setIsAdmin(meBody.role === 'admin');
    if (!inc?.ok) return setBeat('done'); // fail OPEN: a flaky read must not lock the app
    const body = (await inc.json()) as { designatedAt: string | null };
    setBeat(body.designatedAt === null ? 'question' : 'done');
  }, []);
  useEffect(() => { void check(); }, [check, pathname]);

  async function submitQuestion() {
    const picked = CHOICES.find((c) => c.key === choice);
    if (!picked) return;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/incumbents', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: picked.models, other: picked.other, samplingConsent: consent }),
    }).catch(() => null);
    if (!res?.ok) {
      setBusy(false);
      setError('Could not save — try again.');
      return;
    }
    if (!isAdmin) { setBusy(false); return setBeat('done'); } // members cannot mint; the org's admin already did
    // O1: the description → interpreted mix → the instant reveal. Failure is
    // never a wall — the flow continues to the key beat without the reveal.
    if (description.trim().length >= 3) {
      const ir = await fetch('/api/onboarding/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      }).catch(() => null);
      setBusy(false);
      if (ir?.ok) {
        setInterp((await ir.json()) as InterpretResponse);
        setBeat('reveal');
        void prepareKey(); // key + base URL are ready when they arrive there
        return;
      }
    } else {
      setBusy(false);
    }
    setBeat('key');
    void prepareKey();
  }

  async function prepareKey() {
    setError(null);
    const conn = await fetch('/api/connection', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as
      | { baseUrl?: string; servingKeys?: Array<{ revokedAt: string | null }> }
      | null;
    if (conn?.baseUrl) setBaseUrl(conn.baseUrl);
    const hasLive = (conn?.servingKeys ?? []).some((k) => !k.revokedAt);
    if (!hasLive) {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'first key' }),
      }).catch(() => null);
      if (res?.ok) {
        const body = (await res.json()) as { apiKey?: string };
        if (body.apiKey) setRawKey(body.apiKey);
      }
      // Mint failure is not a wall: the flow continues; keys live in Settings.
    }
    // The payoff: reading /api/router right here IS the moment the org's
    // router v1 gets compiled and minted — the artifact exists because this
    // flow just gave it a quality bar. Absent a policy it stays quiet.
    const r = await fetch('/api/router', { cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null) as
      | { name?: string; version?: number; document?: { policy?: unknown } }
      | null;
    if (r?.name !== undefined && r.version !== undefined && r.document?.policy) {
      setRouter({ name: r.name, version: r.version });
    }
  }

  async function sendFirst(text: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await routeOnce(text, 'policy', {
        onReceipt: (r) => {
          setReceipt(r);
          try { sessionStorage.setItem(FIRST_RECEIPT_KEY, JSON.stringify(r)); } catch { /* private mode */ }
          setBeat('printed');
        },
        onError: (msg) => setError(msg),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    // The page beneath the overlay mounted BEFORE this flow ran — its server
    // data and effects predate the key and the receipt. A full navigation
    // gives Today fresh SSR and a fresh sessionStorage read, so it opens in
    // the routing state with the printed receipt on it.
    setBeat('done');
    window.location.assign('/');
  }

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1600);
    } catch { /* clipboard unavailable */ }
  }

  if (beat === 'checking' || beat === 'done') return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f4f2ec]">
      <div className="mx-auto max-w-xl px-6 py-14">
        <div className="flex items-center gap-2">
          <Mark className="h-5 w-5 text-accent" />
          <span className="text-lg font-semibold tracking-tight text-ink">Potion</span>
        </div>

        {beat === 'question' && (
          <>
            <div className="mt-8 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">One question, then you&rsquo;re in</div>
            <h1 className="mt-2 text-[1.8rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              What are you building?
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-soft">
              One sentence is enough — describe the product, or paste a typical prompt. Potion works
              out what kinds of work it needs and builds your router around them. You never choose
              models, thresholds, or fallbacks.
            </p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="An AI support agent for our e-commerce platform… / Extract financials from PDFs… / Code review tool…"
              className="mt-4 w-full resize-none border border-[#d9d5cb] bg-white px-4 py-3 text-[15px] text-ink placeholder:text-faint focus:border-ink focus:outline-none"
              data-testid="onboarding-description"
            />
            <p className="mt-5 text-[13px] leading-relaxed text-soft">
              <span className="font-medium text-ink">Already running on something?</span> Name it and
              your savings are verified against it — <span className="text-ink">never below what you
              get now</span>. Building fresh? Pick the last option.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CHOICES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setChoice(c.key)}
                  className={`border px-4 py-4 text-left transition-colors ${
                    choice === c.key ? 'border-ink bg-[#fbfaf7]' : 'border-[#d9d5cb] bg-white hover:border-ink'
                  }`}
                >
                  <div className="text-[15px] font-medium text-ink">{c.label}</div>
                  <div className="mt-0.5 text-[12px] text-faint">{c.sub}</div>
                </button>
              ))}
            </div>
            <label className="mt-6 flex items-start gap-3 border border-[#d9d5cb] bg-[#fbfaf7] px-4 py-4">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-1 h-3.5 w-3.5 accent-[#1c1a17]"
              />
              <span className="text-[13px] leading-relaxed text-soft">
                <span className="font-medium text-ink">Measure my workloads.</span> Potion keeps a small,
                redacted sample of your requests (capped per kind of work) for one purpose: measuring
                quality on your actual work, so your routing improves with evidence. Turn it off anytime;
                deleting your organization deletes the samples.
              </span>
            </label>
            <div className="mt-6 flex items-center gap-4">
              <button
                type="button"
                onClick={() => void submitQuestion()}
                disabled={busy || choice === null}
                className="bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Saving…' : 'Continue'}
              </button>
              {choice === null && <span className="text-[12px] text-faint">Pick one — &ldquo;not sure&rdquo; is a fine answer.</span>}
              {choice !== null && description.trim().length < 3 && (
                <span className="text-[12px] text-faint">Describing what you&rsquo;re building gets you a router preview on the next screen.</span>
              )}
            </div>
          </>
        )}

        {beat === 'reveal' && interp && (
          <>
            <div className="mt-8 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">We understood the workload</div>
            <h1 className="mt-2 text-[1.8rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              Your router is ready.
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-soft">{interp.summary}</p>

            <div className="mt-5 border border-accent/50 bg-[#fbfaf7]" data-testid="onboarding-reveal">
              <div className="flex items-baseline justify-between border-b border-[#d9d5cb] px-5 py-3">
                <span className="font-mono text-[13px] text-ink">{interp.router.name}</span>
                <span className="font-mono text-[12px] uppercase tracking-[0.1em] text-accent">v{interp.router.version} · provisional</span>
              </div>
              <div className="px-5 py-4">
                {interp.assignments.map((a) => (
                  <div key={a.clusterId} className="flex items-baseline justify-between gap-3 border-b border-dashed border-[#d9d5cb] py-1.5 font-mono text-[12.5px] last:border-0">
                    <span className="text-soft">{Math.round(a.share * 100)}% · {a.clusterId}</span>
                    <span className="text-ink">→ {a.label}{a.quality !== null ? ` · q ${a.quality.toFixed(2)}` : ''}</span>
                  </div>
                ))}
                {interp.assignments.some((a) => a.quality !== null) ? (
                  <p className="mt-2 font-mono text-[12px] leading-relaxed text-faint">
                    q · measured quality for that kind of work, on Potion&rsquo;s live suites — the
                    best score money can buy sets the bar, and your policy picks the point under it
                  </p>
                ) : null}
                {interp.expected && (
                  <>
                    {/* The honest triangle (2026-08-28): both qualities AND
                        both costs on the table — the trade is visible, and
                        price speaks as a ratio bound to quality, never a
                        naked percent-off (the endorsed-landing formula).
                        The counterfactual LADDER (operator, same day): the
                        org's NAMED incumbent when we've measured it — the
                        personal comparison — else the best-scorer ceiling,
                        labeled as the ceiling it is. Never a simulation of
                        someone else's router: unmeasurable claims are the
                        actual swindle. */}
                    {interp.expected.incumbent ? (
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-[#d9d5cb] pt-3 font-mono text-[12.5px] sm:grid-cols-4" data-testid="expected-vs-incumbent">
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">expected quality</span><span className="text-ink">{(interp.expected.quality * 100).toFixed(1)}%<span className="text-faint"> vs {(interp.expected.incumbent.quality * 100).toFixed(1)}</span></span></span>
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">expected cost</span><span className="text-ink">${interp.expected.costPer1K.toFixed(2)}/1K</span></span>
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">{interp.expected.incumbent.model}, everywhere</span><span className="text-ink">${interp.expected.incumbent.costPer1K.toFixed(2)}/1K</span></span>
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">your price</span><span className="font-semibold text-kept">{priceVsBaseline(interp.expected.costPer1K, interp.expected.incumbent.costPer1K)}</span></span>
                      </div>
                    ) : (
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-[#d9d5cb] pt-3 font-mono text-[12.5px] sm:grid-cols-4">
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">expected quality</span><span className="text-ink">{(interp.expected.quality * 100).toFixed(1)}%{interp.expected.baselineQuality !== undefined ? <span className="text-faint"> vs {(interp.expected.baselineQuality * 100).toFixed(1)}</span> : null}</span></span>
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">expected cost</span><span className="text-ink">${interp.expected.costPer1K.toFixed(2)}/1K</span></span>
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">best scorer, everywhere</span><span className="text-ink">${interp.expected.baselineCostPer1K.toFixed(2)}/1K</span></span>
                        <span><span className="block text-[11px] uppercase tracking-[0.1em] text-faint">your price</span><span className="font-semibold text-kept">{priceVsBaseline(interp.expected.costPer1K, interp.expected.baselineCostPer1K)}</span></span>
                      </div>
                    )}
                    <p className="mt-2 font-mono text-[12px] leading-relaxed text-faint">
                      {interp.expected.incumbent
                        ? <>measured against the model you named — {interp.expected.incumbent.model} on every request, from live suite evidence. your Savings page verifies against what you actually pay, per receipt — never below what you get now</>
                        : <>the comparison is the premium counterfactual — the top-scoring model on every request (you&rsquo;re starting fresh, so there&rsquo;s no incumbent bill to compare). your Savings page verifies what you actually keep, per receipt</>}
                    </p>
                  </>
                )}
              </div>
              {/* The learning promise — the product's core loop, said plainly
                  and prominently (operator, 2026-08-28: "this needs to be
                  very clear"), and honestly per the consent choice. */}
              <div className="border-t border-accent/40 px-5 py-3.5" data-testid="reveal-learning">
                <div className="font-mono text-[12px] uppercase tracking-[0.12em] text-accent">
                  this router gets better on its own — here&rsquo;s exactly how
                </div>
                {consent ? (
                  <ol className="mt-2 grid gap-1.5 text-[13px] leading-relaxed text-soft">
                    <li><span className="font-medium text-ink">Today · provisional.</span> Built from Potion&rsquo;s live platform measurements at your described mix — it works from the first request.</li>
                    <li><span className="font-medium text-ink">This week · measured on YOUR work.</span> Potion samples your real prompts (small, redacted, capped) and scores quality per kind of work — on your traffic, not a benchmark.</li>
                    <li><span className="font-medium text-ink">Then, always · personalized.</span> When the evidence shows a better point, an upgrade proposal appears — one click mints the next router version, with the change and the saving written on it. Never silently.</li>
                  </ol>
                ) : (
                  <p className="mt-2 text-[13px] leading-relaxed text-soft">
                    You turned workload measurement <b>off</b>, so this router stays on Potion&rsquo;s
                    platform measurements — still live, still verified, but it won&rsquo;t personalize
                    to your prompts. Flip it on anytime in Settings and the measuring starts.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-6 flex items-center gap-4">
              <button type="button" onClick={() => setBeat('key')} className="bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90" data-testid="use-this-router">
                Use this router →
              </button>
              <button type="button" onClick={() => setBeat('question')} className="text-[12px] text-faint underline hover:text-soft">
                that&rsquo;s not what I&rsquo;m building — re-describe
              </button>
            </div>
          </>
        )}

        {beat === 'key' && (
          <>
            <div className="mt-8 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
              Step 2 of 4 · {router ? 'your router, compiled' : 'your key'}
            </div>
            <h1 className="mt-2 text-[1.8rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              {router ? 'Your router is compiled. Point your client at it.' : 'Point your client here. Keep everything else.'}
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-soft">
              Potion speaks the OpenAI protocol — requests, streaming, and tool calls unchanged.
              {rawKey ? ' Your key is shown once; Potion keeps only a hash.' : ''}
            </p>
            <div className="mt-6 space-y-3">
              {router && (
                <div className="flex items-center justify-between gap-3 border border-accent/50 bg-[#fbfaf7] px-4 py-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-accent">
                      your router · v{router.version} · compiled just now from your bar
                    </div>
                    <div className="truncate font-mono text-[13px] text-ink">model: &apos;{router.name}&apos;</div>
                  </div>
                  <button type="button" onClick={() => void copy(router.name, 'router')} className="shrink-0 border border-ink px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-ink hover:text-[#f4f2ec]">
                    {copied === 'router' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
              {rawKey && (
                <div className="flex items-center justify-between gap-3 border border-[#d9d5cb] bg-[#fbfaf7] px-4 py-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">api key · shown once</div>
                    <div className="truncate font-mono text-[13px] text-ink">{rawKey}</div>
                  </div>
                  <button type="button" onClick={() => void copy(rawKey, 'key')} className="shrink-0 border border-ink px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-ink hover:text-[#f4f2ec]">
                    {copied === 'key' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 border border-[#d9d5cb] bg-[#fbfaf7] px-4 py-3">
                <div className="min-w-0">
                  <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-faint">base url</div>
                  <div className="truncate font-mono text-[13px] text-ink">{baseUrl ? `${baseUrl}/v1` : 'loading…'}</div>
                </div>
                {baseUrl && (
                  <button type="button" onClick={() => void copy(`${baseUrl}/v1`, 'url')} className="shrink-0 border border-ink px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-ink hover:text-[#f4f2ec]">
                    {copied === 'url' ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
            </div>
            {/* The one story the user must leave with (comprehension pass):
                works day one → read for 1–2 weeks → becomes yours. The
                from-scratch variant answers "but I have nothing to measure". */}
            <div className="mt-5 border border-[#d9d5cb] bg-white px-4 py-3.5">
              <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">how this works</div>
              <ol className="mt-2 grid gap-1.5 text-[13px] leading-relaxed text-soft">
                <li><span className="font-medium text-ink">It works today.</span> v1 routes every request on Potion&rsquo;s live measurements, under your bar — nothing to wait for.</li>
                <li><span className="font-medium text-ink">Weeks 1–2: Potion reads your traffic.</span> A small, redacted, capped sample of your requests is measured to learn what <em>your</em> work is and which models are good enough at it.
                  {choice === 'scratch' ? ' Starting from scratch, there’s no old model to beat — your work is measured against a strong default bar; the arc is the same.' : ''}</li>
                <li><span className="font-medium text-ink">Then it becomes yours.</span> Potion proposes your own quality bar per kind of work — you accept or ignore, nothing changes silently — and your router recompiles as a new version with the change written on it.</li>
              </ol>
            </div>
            <div className="mt-6 flex items-center gap-4">
              <button type="button" onClick={() => setBeat('try')} className="bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90">
                Continue
              </button>
              <button type="button" onClick={finish} className="text-[12px] text-faint underline hover:text-soft">skip for now</button>
            </div>
          </>
        )}

        {beat === 'try' && (
          <>
            <div className="mt-8 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">Step 3 of 4 · one request</div>
            <h1 className="mt-2 text-[1.8rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              Send one request. Watch what happens to it.
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-soft">
              No code needed — this goes through the same routing your key gets.
            </p>
            <div className="mt-6 flex items-start gap-3 border border-[#d9d5cb] bg-white px-4 py-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendFirst(prompt); }}
                rows={2}
                placeholder="Type anything…"
                className="min-w-0 flex-1 resize-none bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void sendFirst(prompt)}
                disabled={busy || prompt.trim().length === 0}
                className="flex h-9 w-9 shrink-0 items-center justify-center bg-ink text-white hover:opacity-85 disabled:opacity-40"
                aria-label="Send"
              >
                {busy ? <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border border-white/50 border-t-white" /> : '↑'}
              </button>
            </div>
            <div className="mt-3 flex items-center gap-4">
              <button
                type="button"
                onClick={() => { setPrompt(SAMPLE); void sendFirst(SAMPLE); }}
                disabled={busy}
                className="border border-[#d9d5cb] px-3 py-1.5 text-left text-xs text-soft hover:border-ink hover:text-ink disabled:opacity-50"
              >
                or use a sample request
              </button>
              <button type="button" onClick={finish} className="text-[12px] text-faint underline hover:text-soft">skip for now</button>
            </div>
          </>
        )}

        {beat === 'printed' && receipt && (
          <>
            <div className="mt-8 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">Step 4 of 4 · your first receipt</div>
            <div className="mt-4">
              {/* the slot the receipt prints from — the one moment of theater */}
              <div className="h-3.5 rounded bg-ink shadow-sm" aria-hidden />
              <div className="mx-2.5">
                <ReceiptCard r={receipt} subtitle="your first request · just now" printing />
              </div>
            </div>
            <p className="mt-5 max-w-md text-[14px] leading-relaxed text-soft">
              <span className="font-medium text-ink">This happens to every request now.</span> What ran,
              what it cost, what the premium pick would have cost — on the answer itself.
            </p>
            <button type="button" onClick={finish} className="mt-5 bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90">
              Go to Today →
            </button>
          </>
        )}

        {error && <p className="mt-4 text-[12px] text-warn">{error}</p>}
      </div>
    </div>
  );
}


