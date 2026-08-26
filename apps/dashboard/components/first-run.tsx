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

const CHOICES: Array<{ key: string; label: string; sub: string; models: string[]; other: string | null }> = [
  { key: 'openai', label: 'OpenAI', sub: 'GPT models', models: ['or-gpt-full'], other: null },
  { key: 'anthropic', label: 'Anthropic', sub: 'Claude models', models: ['or-sonnet'], other: null },
  { key: 'google', label: 'Google', sub: 'Gemini models', models: ['or-gemini-flash'], other: null },
  { key: 'unsure', label: 'Several / not sure', sub: 'Use smart defaults', models: [], other: 'several or unsure — smart defaults' },
  { key: 'scratch', label: 'Building from scratch', sub: 'No AI in production yet', models: [], other: 'building from scratch' },
];

const SAMPLE = 'Is this review positive, negative, or neutral? "Crashed twice, support never replied."';

export const FIRST_RECEIPT_KEY = 'potion:first-receipt';

type Beat = 'checking' | 'question' | 'key' | 'try' | 'printed' | 'done';

export function FirstRunGate() {
  const pathname = usePathname();
  const [beat, setBeat] = useState<Beat>('checking');
  const [choice, setChoice] = useState<string | null>(null);
  const [consent, setConsent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // beat 2
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
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
    setBusy(false);
    if (!res?.ok) {
      setError('Could not save — try again.');
      return;
    }
    if (!isAdmin) return setBeat('done'); // members cannot mint; the org's admin already did
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
    if (hasLive) return; // a key already exists; show the URL, mint nothing
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
            <div className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">One question, then you&rsquo;re in</div>
            <h1 className="mt-2 text-[1.8rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              What do you use for AI today?
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-soft">
              Potion routes each request to the cheapest model measured at your quality bar. If you use
              AI today, we measure against it — <span className="text-ink">never below what you get now</span>.
              Starting fresh? We set a strong default bar and measure your work as it grows. Change this
              anytime in Settings.
            </p>
            <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
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
            </div>
          </>
        )}

        {beat === 'key' && (
          <>
            <div className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Step 2 of 4 · your key</div>
            <h1 className="mt-2 text-[1.8rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              Point your client here. Keep everything else.
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-soft">
              Potion speaks the OpenAI protocol — requests, streaming, and tool calls unchanged.
              {rawKey ? ' Your key is shown once; Potion keeps only a hash.' : ''}
            </p>
            <div className="mt-6 space-y-3">
              {rawKey && (
                <div className="flex items-center justify-between gap-3 border border-[#d9d5cb] bg-[#fbfaf7] px-4 py-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">api key · shown once</div>
                    <div className="truncate font-mono text-[13px] text-ink">{rawKey}</div>
                  </div>
                  <button type="button" onClick={() => void copy(rawKey, 'key')} className="shrink-0 border border-ink px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-ink hover:text-[#f4f2ec]">
                    {copied === 'key' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between gap-3 border border-[#d9d5cb] bg-[#fbfaf7] px-4 py-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">base url</div>
                  <div className="truncate font-mono text-[13px] text-ink">{baseUrl ? `${baseUrl}/v1` : 'loading…'}</div>
                </div>
                {baseUrl && (
                  <button type="button" onClick={() => void copy(`${baseUrl}/v1`, 'url')} className="shrink-0 border border-ink px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-ink hover:text-[#f4f2ec]">
                    {copied === 'url' ? 'Copied' : 'Copy'}
                  </button>
                )}
              </div>
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
            <div className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Step 3 of 4 · one request</div>
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
            <div className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Step 4 of 4 · your first receipt</div>
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
