import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-header';
import { listIssues, RESEARCH_TAGLINE, RESEARCH_TITLE, siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${RESEARCH_TITLE} — weekly measured model routing research · Potion`,
  description: RESEARCH_TAGLINE,
  alternates: { canonical: '/research', types: { 'application/rss+xml': '/research/feed.xml' } },
  openGraph: { title: RESEARCH_TITLE, description: RESEARCH_TAGLINE, type: 'website', url: '/research' },
};

export default function ResearchIndex() {
  const issues = listIssues();
  const origin = siteOrigin();
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: RESEARCH_TITLE,
    description: RESEARCH_TAGLINE,
    url: `${origin}/research`,
    publisher: { '@type': 'Organization', name: 'Potion', url: origin },
    blogPost: issues.map((i) => ({ '@type': 'BlogPosting', headline: i.title, datePublished: i.publishedAt, url: `${origin}/research/${i.slug}` })),
  };
  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <div className="font-mono text-xs uppercase tracking-[0.18em] text-faint">Research · weekly</div>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">{RESEARCH_TITLE}</h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-soft">{RESEARCH_TAGLINE}</p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-soft">
          Every issue is produced from the same measurements that route production traffic: a weekly
          drift check on every routing frontier, auditions of newly listed models, and replayed
          combinations of measured models. Numbers carry intervals; names that are part of the
          product are withheld, their numbers are not.
        </p>
        <div className="mt-12 space-y-8">
          {issues.length === 0 && (
            <p className="rounded-xl border border-line bg-panel p-6 text-sm text-soft">
              The first issue publishes after the next weekly run. The feed at{' '}
              <Link href="/research/feed.xml" className="text-accent underline">/research/feed.xml</Link> will carry it.
            </p>
          )}
          {issues.map((i) => (
            <article key={i.slug} className="border-t border-line pt-6">
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                {i.week} · {i.publishedAt.slice(0, 10)}
              </div>
              <h2 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-ink">
                <Link href={`/research/${i.slug}`} className="hover:text-accent">{i.title}</Link>
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-soft">{i.summary}</p>
              <div className="mt-3 font-mono text-[11px] text-faint">
                {i.facts.numbers.canaries} canaries · {i.facts.numbers.clustersHeld} held · {i.facts.numbers.clustersMoved} moved ·{' '}
                {i.facts.numbers.candidatesMeasured} new models measured · {i.facts.mixing.length} combination finding{i.facts.mixing.length === 1 ? '' : 's'}
              </div>
            </article>
          ))}
        </div>
        <p className="mt-16 font-mono text-[11px] text-faint">
          RSS: <Link href="/research/feed.xml" className="text-accent">/research/feed.xml</Link> · Method: every issue carries the same method note; see the{' '}
          <Link href="/docs" className="text-accent">docs</Link> for the taxonomy and scoring.
        </p>
      </main>
    </SiteShell>
  );
}
