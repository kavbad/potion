// /login (M2 Wave 2, ROADMAP #14) — magic-link sign-in.
//
// TWO PATHS, and the page must not confuse them. When the deployment has a
// real email sender, the response carries no link and "check your email" is
// the truth. When it does NOT, the server returns the link inline
// (POTION_MAGIC_LINK_IN_RESPONSE) — and this page used to render "Check your
// email … we sent a single-use sign-in link to you@…" anyway, then offer the
// link underneath as a footnote. That is a dead end dressed as a next step:
// the server had already said no email was sent, and the page told the user
// to go look for one.
//
// So a returned link is FOLLOWED, not footnoted. Enter an email, and you are
// signed in — no inbox, no second click, and no instruction to wait for
// something that is never coming. The production path is untouched: no link
// in the response means the email copy, unchanged.
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SiteHeader } from '@/components/site-header';

function LoginForm() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'entering'>('idle');
  const [devLink, setDevLink] = useState<string | null>(null);
  const [inviteOnly, setInviteOnly] = useState(false);
  // The type-able path (2026-08-28): the email carries an 8-digit code for
  // signing in on a different device than the inbox — nobody should ever
  // transcribe a 51-character link by hand.
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
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
      const body = (await res.json().catch(() => null)) as { devLink?: string; selfServe?: boolean; error?: { message?: string } } | null;
      if (!res.ok) {
        setFormError(body?.error?.message ?? `sign-in failed (HTTP ${res.status})`);
        setState('idle');
        return;
      }
      const link = body?.devLink ?? null;
      if (link) {
        // The server told us there is no email server. Use the link rather
        // than sending the user to an inbox that will never receive one.
        setDevLink(link);
        setState('entering');
        window.location.href = link;
        return;
      }
      setDevLink(null);
      setInviteOnly(body?.selfServe === false);
      setState('sent');
    } catch {
      setFormError('the Potion API is unreachable — start apps/server first.');
      setState('idle');
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setCodeBusy(true);
    setFormError(null);
    try {
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
      if (res.ok && body?.ok) {
        window.location.assign('/');
        return;
      }
      setFormError(body?.error?.message ?? 'that code did not work — request a fresh email');
    } catch {
      setFormError('the Potion API is unreachable.');
    } finally {
      setCodeBusy(false);
    }
  }

  return (
    <div className="max-w-md">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Sign in to Potion</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        Passwordless — no password to choose or forget. First sign-in creates your workspace;
        teammates join by admin invite.
      </p>

      {formError && (
        <div className="mb-6 border border-warn px-6 py-4">
          <p className="text-sm font-medium text-warn">{formError}</p>
        </div>
      )}

      <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-8 py-8">
        {state === 'entering' ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">Signing you in…</p>
            <p className="text-sm leading-relaxed text-soft">
              This deployment has no email sender configured, so Potion signed you in directly
              instead of mailing a link.
            </p>
            {devLink && (
              <a href={devLink} className="text-sm font-medium text-accent underline">
                Continue
              </a>
            )}
          </div>
        ) : state === 'sent' && inviteOnly ? (
          <div className="space-y-3" data-testid="invite-only-note">
            <p className="text-sm font-medium text-ink">Potion is invite-only right now</p>
            <p className="text-sm leading-relaxed text-soft">
              A sign-in email goes out only to invited addresses. If{' '}
              <span className="font-medium text-ink">{email}</span> has an invite, the link is on
              its way; otherwise ask the person who showed you Potion to invite you from
              Settings → Team.
            </p>
          </div>
        ) : state === 'sent' ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-ink">Check your email</p>
            <p className="text-sm leading-relaxed text-soft">
              We sent a single-use sign-in link to{' '}
              <span className="font-medium text-ink">{email}</span>. It expires in 15 minutes.
            </p>
            <form onSubmit={submitCode} className="space-y-2 border-t border-dashed border-[#d9d5cb] pt-3">
              <label className="block text-sm text-soft" htmlFor="signin-code">
                Reading the email on another device? Type the 8-digit code from it:
              </label>
              <div className="flex gap-2">
                <input
                  id="signin-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="1234 5678"
                  className="w-36 rounded-md border border-line bg-paper px-3 py-2 font-mono text-sm tracking-[0.08em] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
                  data-testid="signin-code"
                />
                <button
                  type="submit"
                  disabled={codeBusy || code.replace(/\D/g, '').length !== 8}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
                  data-testid="signin-code-submit"
                >
                  {codeBusy ? 'Checking…' : 'Sign in'}
                </button>
              </div>
            </form>
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

      {/* G2.4: the demo credential is seeded only when POTION_SEED_DEMO is
          set, so this advertisement ships only when the demo tenant really
          has one — never in the operator-only production posture. */}
      {process.env.NEXT_PUBLIC_SEED_DEMO === '1' && (
        <p className="mt-6 text-xs leading-relaxed text-faint">
          Demo workspace? Sign in as <code className="font-mono">demo@potion.dev</code> — the seeded
          admin of the demo org.
        </p>
      )}
    </div>
  );
}

export default function LoginPage() {
  // The root layout draws the app sidebar only when a session cookie exists,
  // which by definition it does not here — so the sign-in page brings the
  // public header itself. Without it this route renders as a bare form on an
  // empty page, with no mark and no way back to the landing page.
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <div className="mx-auto max-w-5xl px-6 py-20">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
