'use client';
// P1-6: the moment something breaks is the moment the product must not look
// abandoned. Digest shown so a report to us is actionable; no stack traces.
import Link from 'next/link';
import { Mark } from '@/components/mark';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f4f2ec] px-6">
      <Mark className="h-8 w-8 text-accent" />
      <div className="mt-6 font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">Something broke</div>
      <h1 className="mt-2 text-center text-[1.6rem] font-medium tracking-[-0.02em] text-ink">This page hit an error</h1>
      <p className="mt-3 max-w-sm text-center text-[13.5px] leading-relaxed text-soft">
        Your data and requests are unaffected — this is a display failure. Trying again usually works;
        if it keeps happening, email kavon@mutiny.ai{error.digest ? ' and mention the code below' : ''}.
      </p>
      {(error.digest || error.message) && (
        <p className="mt-3 max-w-md text-center font-mono text-[12px] leading-relaxed text-faint">
          {error.digest ?? String(error.message).slice(0, 140)}
        </p>
      )}
      <div className="mt-8 flex gap-3">
        <button type="button" onClick={reset} className="bg-ink px-4 py-2 text-[12px] font-medium text-[#f4f2ec] hover:opacity-85">
          Try again
        </button>
        <Link href="/" className="border border-[#d9d5cb] px-4 py-2 text-[12px] font-medium text-soft hover:border-ink hover:text-ink">
          Go to your dashboard
        </Link>
      </div>
    </div>
  );
}
