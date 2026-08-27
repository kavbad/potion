// The measured answers — hub (Answer Engine C1). Frontier Notes' reference
// section: one page per kind of work, generated from the live platform
// frontiers, refreshed when measurements move. Server-rendered: AEO crawlers
// get full content in the initial HTML.
import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-header';
import { ANSWER_PAGES, fetchPublicAnswers } from '@/lib/answers';
import { siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'The Measured Answers — which model for which work · Frontier Notes',
  description:
    'Live-measured answers to "which model should I use for this workload, and what does it cost" — quality, price, and latency per kind of work, re-measured weekly with confidence intervals.',
  alternates: { canonical: '/answers' },
  openGraph: {
    title: 'The Measured Answers · Frontier Notes',
    description: 'Which model for which work — measured weekly, with receipts.',
    type: 'website',
    url: '/answers',
  },
};

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default async function AnswersHub() {
  const data = await fetchPublicAnswers();
  const origin = siteOrigin();
  const measured = (data?.clusters ?? []).filter((c) => ANSWER_PAGES.some((p) => p.clusterId === c.clusterId));
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'The Measured Answers',
    description: 'Live-measured model quality, cost, and latency per kind of work.',
    url: `${origin}/answers`,
    isPartOf: { '@type': 'Blog', name: 'Frontier Notes', url: `${origin}/research` },
    publisher: { '@type': 'Organization', name: 'Potion', url: origin },
    hasPart: measured.map((c) => {
      const page = ANSWER_PAGES.find((p) => p.clusterId === c.clusterId)!;
      return { '@type': 'Article', headline: page.question, url: `${origin}/answers/${page.slug}`, dateModified: c.measuredAt };
    }),
  };

  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <div className="font-mono text-xs uppercase tracking-[0.14em] text-faint">
          <Link href="/research" className="hover:text-accent">Frontier Notes</Link> · the reference section
        </div>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">The Measured Answers</h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-soft">
          Which model should you use for this kind of work, and what does it cost? Below are the
          live-measured answers — quality, price per 1,000 requests, and latency — re-measured
          weekly, stated with dates and intervals, from the same measurements that route
          production traffic. Names that are part of the product are withheld; their numbers are not.
        </p>
        <p className="mt-3 font-mono text-[12.5px] text-faint">
          method: <Link href="/research/methodology" className="text-accent underline">how these numbers are made</Link>
          {' · '}every page updates when its measurement does
        </p>

        <div className="mt-12 space-y-6">
          {measured.length === 0 && (
            <p className="border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
              Live-measured pages publish from the production frontiers. If you are seeing this on a
              local build, there are no live measurements to show — by design, simulated numbers
              never appear here.
            </p>
          )}
          {measured.map((c) => {
            const page = ANSWER_PAGES.find((p) => p.clusterId === c.clusterId)!;
            const top = c.points.reduce((m, p) => Math.max(m, p.quality), 0);
            const cheapest = c.points[0]!; // sorted by cost server-side
            return (
              <article key={c.clusterId} className="border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-5">
                <div className="flex items-baseline justify-between gap-4">
                  <h2 className="text-lg font-semibold leading-snug tracking-tight text-ink">
                    <Link href={`/answers/${page.slug}`} className="hover:text-accent">{page.question}</Link>
                  </h2>
                  <span className="shrink-0 font-mono text-[11.5px] uppercase tracking-[0.12em] text-faint">
                    v{c.version} · {c.measuredAt.slice(0, 10)}
                  </span>
                </div>
                <p className="mt-2 font-mono text-[12px] leading-relaxed text-soft">
                  {c.points.length} measured options · top quality {top.toFixed(3)} · from {money(cheapest.costPer1K)}/1K requests
                </p>
              </article>
            );
          })}
        </div>

        <p className="mt-14 text-[13.5px] leading-relaxed text-soft">
          This section is part of <Link href="/research" className="text-accent underline">Frontier Notes</Link>,
          Potion Research&apos;s publication: the weekly issue covers what moved and what failed; these
          pages hold the current answers. Every claim links to its method, and negatives are
          published with the same prominence as wins.
        </p>
      </main>
    </SiteShell>
  );
}
