'use client';

// FIRST RUN (operator directive, 2026-08-24): personalization is never
// skippable again. A brand-new signed-in user meets ONE screen before the
// dashboard: one question at PROVIDER level (nobody enumerates their model
// list — that was dumb onboarding), a smart default for "not sure", and the
// sampling-consent decision made explicitly at signup. Everything states it
// can be changed later. The gate is the DASHBOARD's front door; the API is
// deliberately not gated — a served request must never fail on onboarding.
import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Mark } from '@/components/mark';

const CHOICES: Array<{ key: string; label: string; sub: string; models: string[]; other: string | null }> = [
  { key: 'openai', label: 'OpenAI', sub: 'GPT models', models: ['or-gpt-full'], other: null },
  { key: 'anthropic', label: 'Anthropic', sub: 'Claude models', models: ['or-sonnet'], other: null },
  { key: 'google', label: 'Google', sub: 'Gemini models', models: ['or-gemini-flash'], other: null },
  { key: 'unsure', label: 'Several / not sure', sub: 'Use smart defaults', models: [], other: 'several or unsure — smart defaults' },
];

export function FirstRunGate() {
  const pathname = usePathname();
  const [state, setState] = useState<'checking' | 'needed' | 'done'>('checking');
  const [choice, setChoice] = useState<string | null>(null);
  const [consent, setConsent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    const [me, inc] = await Promise.all([
      fetch('/api/auth/me', { cache: 'no-store' }).catch(() => null),
      fetch('/api/incumbents', { cache: 'no-store' }).catch(() => null),
    ]);
    // Only SESSION users (humans in the dashboard) are gated; unauthenticated
    // and api-key contexts pass through — pages handle those states already.
    if (!me?.ok) return setState('done');
    const meBody = (await me.json()) as { user?: unknown; kind?: string };
    if (!meBody.user || meBody.kind !== 'session') return setState('done');
    if (!inc?.ok) return setState('done'); // fail OPEN: a flaky read must not lock the app
    const body = (await inc.json()) as { designatedAt: string | null };
    setState(body.designatedAt === null ? 'needed' : 'done');
  }, []);
  useEffect(() => { void check(); }, [check, pathname]);

  async function submit() {
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
    setState('done');
  }

  if (state !== 'needed') return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f4f2ec]">
      <div className="mx-auto max-w-xl px-6 py-14">
        <div className="flex items-center gap-2">
          <Mark className="h-5 w-5 text-accent" />
          <span className="text-lg font-semibold tracking-tight text-ink">Potion</span>
        </div>
        <div className="mt-8 font-mono text-[11px] uppercase tracking-[0.18em] text-faint">One question, then you&rsquo;re in</div>
        <h1 className="mt-2 text-[1.8rem] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
          What do you use for AI today?
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-soft">
          Potion routes each request to the cheapest model measured at your quality bar. Telling us
          your starting point lets us measure against it — <span className="text-ink">never below what you get today</span>.
          You can change this anytime in Settings.
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
            onClick={() => void submit()}
            disabled={busy || choice === null}
            className="bg-ink px-5 py-2.5 text-[13px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Start using Potion'}
          </button>
          {choice === null && <span className="text-[12px] text-faint">Pick one — &ldquo;not sure&rdquo; is a fine answer.</span>}
        </div>
        {error && <p className="mt-3 text-[12px] text-warn">{error}</p>}
      </div>
    </div>
  );
}
