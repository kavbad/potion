// Public chrome. The app shell is a 240px sidebar of operator tools, which is
// the correct frame for someone who has signed in and wrong for everyone
// else — a visitor should not meet the product as a control panel. Public
// pages (landing, docs, sign-in) get this instead: mark, wordmark, two links.
import Link from 'next/link';
import { Mark } from '@/components/mark';

export function SiteHeader({ current }: { current?: 'docs' }) {
  return (
    <>
      {/* exa-style announcement bar — ours carries the masked discovery */}
      <div className="bg-accent px-4 py-2 text-center text-xs text-white">
        This week we measured a model at{' '}
        <Link href="/home#evidence" className="font-medium text-white underline decoration-white/60 underline-offset-2 hover:decoration-white">
          1/270th the price of the best — at 99% of its quality
        </Link>
        . The name is the product.
      </div>
      <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:grid sm:grid-cols-[1fr_auto_1fr] sm:px-6 sm:py-4">
        <Link href="/" className="flex items-center gap-2 justify-self-start">
          <Mark className="h-5 w-5 text-accent" />
          <span className="text-lg font-semibold tracking-tight text-ink">Potion</span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm sm:flex">
          <Link
            href="/docs"
            className={
              current === 'docs' ? 'font-medium text-ink' : 'text-soft transition-colors hover:text-ink'
            }
          >
            Docs
          </Link>
          <Link href="/leaderboard" className="text-soft transition-colors hover:text-ink">
            Leaderboard
          </Link>
        </nav>
        <div className="flex items-center gap-2.5 justify-self-end text-sm">
          <Link
            href="/login"
            className="hidden rounded-md bg-paper px-3.5 py-1.5 font-medium text-soft ring-1 ring-line transition-colors hover:bg-line/40 hover:text-ink sm:inline-block"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="rounded-md bg-ink px-3.5 py-1.5 font-medium text-white hover:opacity-85 active:translate-y-px active:scale-[0.99]"
          >
            Get a key
          </Link>
        </div>
      </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 bg-[#292524] text-[#a8a29e]">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-10 text-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Mark className="h-4 w-4 text-[#2dd4bf]" />
          <span className="text-[#d6d3d1]">Potion — pay only for the quality you need.</span>
        </div>
        <div className="flex gap-6">
          <Link href="/docs" className="transition-colors hover:text-[#faf9f6]">Docs</Link>
          <Link href="/leaderboard" className="transition-colors hover:text-[#faf9f6]">Leaderboard</Link>
          <Link href="/login" className="transition-colors hover:text-[#faf9f6]">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}

/** Public page frame: header, content, footer. Pages own their own widths. */
export function SiteShell({ children, current }: { children: React.ReactNode; current?: 'docs' }) {
  return (
    <div className="min-h-screen">
      <SiteHeader current={current} />
      {children}
      <SiteFooter />
    </div>
  );
}
