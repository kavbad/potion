// /hero-lab — comp gallery, unlinked. Three hero directions side by side so
// the operator can point at one instead of waiting through another
// single-guess iteration. Not part of the product surface; delete freely.
import Link from 'next/link';
import { Landing } from '@/components/landing';
import { Receipt } from '@/components/landing/receipt';
import { SiteShell } from '@/components/site-header';
import { blendedSavingPct, savingsAt } from '@/lib/economics';

export const dynamic = 'force-dynamic';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-y-2 border-accent bg-accent-soft/40 px-6 py-3 font-mono text-xs uppercase tracking-widest text-accent">
      {children}
    </div>
  );
}

export default function HeroLab() {
  const saved = Math.round(blendedSavingPct(savingsAt(0.8)));
  return (
    <SiteShell>
      <Label>Direction A — centred stage + instrument tape (LIVE on /home)</Label>
      <Landing />

      <Label>Direction B — the derived numeral</Label>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-28 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-faint">
            Measured model routing
          </div>
          <h1 className="mt-6 text-5xl font-semibold leading-[1.04] tracking-tight text-ink">
            Cut your AI bill in half.
            <span className="mt-1 block text-soft">Every choice backed by measurement.</span>
          </h1>
          <p className="mt-8 max-w-lg text-lg leading-relaxed text-soft">
            Companies pick one expensive model and send it everything — the hard questions and the
            easy ones alike. Potion reads each request, works out what kind of job it is, and sends
            it to the cheapest thing measured good enough to do it: sometimes one model, sometimes
            several working together.
          </p>
          <div className="mt-9 flex gap-4">
            <Link href="/login" className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white">
              Get an API key
            </Link>
            <Link href="/docs" className="self-center text-sm font-medium text-accent underline underline-offset-4">
              Read the docs
            </Link>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[11rem] font-medium leading-none tracking-tight text-accent">
            −{saved}
            <span className="text-[5rem]">%</span>
          </div>
          <div className="mt-2 flex items-center justify-end" aria-hidden>
            <span className="h-px w-24 bg-line" />
            <span className="h-2.5 w-px bg-line" />
          </div>
          <div className="mt-2 font-mono text-xs uppercase tracking-wider text-faint">
            measured, at a 0.80 quality floor
          </div>
        </div>
      </section>

      <Label>Direction C — the printed receipt</Label>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-28 lg:grid-cols-[1fr_0.95fr]">
        <div>
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-faint">
            Measured model routing
          </div>
          <h1 className="mt-6 text-5xl font-semibold leading-[1.04] tracking-tight text-ink">
            Cut your AI bill in half.
            <span className="mt-1 block text-soft">Every choice backed by measurement.</span>
          </h1>
          <p className="mt-8 max-w-lg text-lg leading-relaxed text-soft">
            Companies pick one expensive model and send it everything — the hard questions and the
            easy ones alike. Potion reads each request, works out what kind of job it is, and sends
            it to the cheapest thing measured good enough to do it: sometimes one model, sometimes
            several working together.
          </p>
        </div>
        <Receipt />
      </section>
    </SiteShell>
  );
}
