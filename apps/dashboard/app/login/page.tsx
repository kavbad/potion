// /login (M2 Wave 2, ROADMAP #14) — magic-link sign-in. Email in → "check
// your email" state; in dev mode (server dev bypass on) the link is shown
// inline so the whole flow works without an email server. Warm paper
// neutrals + the one teal accent, matching the rest of the dashboard.
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function LoginForm() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [devLink, setDevLink] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(error);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setFormError(null);
    try {
      const res = await fetch('/api/auth/request-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => null)) as { devLink?: string; error?: { message?: string } } | null;
      if (!res.ok) {
        setFormError(body?.error?.message ?? `sign-in failed (HTTP ${res.status})`);
        setState('idle');
        return;
      }
      setDevLink(body?.devLink ?? null);
      setState('sent');
    } catch {
      setFormError('the Potion API is unreachable — start apps/server first.');
      setState('idle');
    }
  }

  return (
    <div className="max-w-md">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to Potion</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Passwordless: we email you a single-use sign-in link. First sign-in creates your
        workspace; teammates join by admin invite.
      </p>

      {formError && (
        <div className="mb-6 rounded-lg border border-warn bg-amber-50 px-6 py-4">
          <p className="text-sm font-medium text-warn">{formError}</p>
        </div>
      )}

      <div className="rounded-xl border border-line bg-panel px-8 py-8">
        {state === 'sent' ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">Check your email</p>
            <p className="text-sm leading-relaxed text-soft">
              We sent a single-use sign-in link to{' '}
              <span className="font-medium text-ink">{email}</span>. It expires in 15 minutes.
            </p>
            {devLink && (
              <p className="rounded-lg bg-accent-soft px-4 py-3 text-sm leading-relaxed text-accent">
                <span className="font-medium">Dev mode:</span> no email server here —{' '}
                <a href={devLink} className="font-medium underline">
                  click to sign in
                </a>
                .
              </p>
            )}
            <button
              type="button"
              onClick={() => setState('idle')}
              className="text-sm text-faint underline hover:text-soft"
            >
              use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <label className="block text-sm font-medium text-ink" htmlFor="email">
              Work email
            </label>
            <input
              id="email"
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full rounded-md border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={state === 'sending'}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-800 disabled:opacity-50"
            >
              {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </form>
        )}
      </div>

      <p className="mt-6 text-xs leading-relaxed text-faint">
        Demo workspace? Sign in as <code className="font-mono">demo@potion.dev</code> — the seeded
        admin of the demo org.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
