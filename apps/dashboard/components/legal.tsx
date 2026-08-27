// Shared frame for the legal pages (/terms, /privacy). Same voice as the
// rest of the site: plain sentences, no boilerplate wall. DRAFT status is
// rendered on the page until counsel has reviewed — honesty over polish.
import type { ReactNode } from 'react';

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">Potion, a product by Mutiny</div>
      <h1 className="mt-2 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">{title}</h1>
      <p className="mt-2 text-[12px] text-faint">Last updated {updated}. Questions: kavon@mutiny.ai.</p>
      <div className="mt-8 space-y-8">{children}</div>
    </main>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-medium text-ink">{heading}</h2>
      <div className="mt-2 space-y-3 text-[13.5px] leading-relaxed text-soft">{children}</div>
    </section>
  );
}
