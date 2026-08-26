// FRONTIER NOTES — the publication front page (redesigned 2026-08-25, the
// answer-engine build). One masthead over three editions: the weekly issue
// (featured + archive), the daily notes (same archive as they land), and
// the measured-answers reference section. Lab-journal identity: double-rule
// masthead, mono metadata, ledger dividers — the receipts aesthetic, public.
import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-header';
import { ANSWER_PAGES, fetchPublicAnswers } from '@/lib/answers';
import { listIssues, RESEARCH_TAGLINE, RESEARCH_TITLE, siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${RESEARCH_TITLE} — weekly measured model routing research · Potion`,
  description: RESEARCH_TAGLINE,
  alternates: { canonical: '/research', types: { 'application/rss+xml': '/research/feed.xml' } },
  openGraph: { title: RESEARCH_TITLE, description: RESEARCH_TAGLINE, type: 'website', url: '/research' },
};

export default async function ResearchIndex() {
  const issues = listIssues();
  const origin = siteOrigin();
  const answers = await fetchPublicAnswers();
  const measured = ANSWER_PAGES.filter((p) => answers?.clusters.some((c) => c.clusterId === p.clusterId));
  const [latest, ...rest] = issues;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: RESEARCH_TITLE,
    description: RESEARCH_TAGLINE,
    url: `${origin}/research`,
    publisher: { '@type': 'Organization', name: 'Potion', url: origin, sameAs: [`${origin}/home`] },
    blogPost: issues.map((i) => ({ '@type': 'BlogPosting', headline: i.title, datePublished: i.publishedAt, url: `${origin}/research/${i.slug}` })),
  };

  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        {/* ---- the masthead: double rule, the name, the contract ---- */}
        <header>
          <div className="border-t-2 border-ink" />
          <div className="mt-[3px] border-t border-ink" />
          <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-faint">
            <span>by Potion Research</span>
            <span>weekly · negatives included</span>
          </div>
          <h1 className="mt-3 text-[3rem] font-semibold leading-[0.98] tracking-[-0.03em] text-ink sm:text-[4.2rem]">
            Frontier Notes
          </h1>
          <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-soft">{RESEARCH_TAGLINE}</p>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-faint">
            <Link href="/answers" className="text-accent underline underline-offset-2">the measured answers</Link>
            <Link href="/research/methodology" className="text-accent underline underline-offset-2">methodology</Link>
            <Link href="/research/feed.xml" className="text-accent underline underline-offset-2">rss</Link>
          </div>
          <div className="mt-6 border-t border-ink" />
          <div className="mt-[3px] border-t-2 border-ink" />
        </header>

        <p className="mt-8 max-w-2xl text-[13.5px] leading-relaxed text-soft">
          Every number here is produced by the same measurements that route production traffic:
          weekly drift checks on every routing frontier, auditions of newly listed models, and
          replayed combinations. Numbers carry dates, sample sizes, and intervals. Names that are
          part of the product are withheld; their numbers are not. When a hypothesis fails, the
          failure is published.
        </p>

        {/* ---- featured latest issue ---- */}
        {latest ? (
          <article className="mt-10 border border-[#c4bfb2] bg-[#fbfaf7] px-7 py-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              <span className="text-accent">{latest.kind === 'daily' ? 'daily note' : 'latest issue'} · {latest.week}</span>
              <span>{latest.publishedAt.slice(0, 10)}</span>
            </div>
            <h2 className="mt-3 text-[1.7rem] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
              <Link href={`/research/${latest.slug}`} className="hover:text-accent">{latest.title}</Link>
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">{latest.summary}</p>
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-dashed border-[#d9d5cb] pt-3 font-mono text-[11px] text-faint">
              {latest.facts ? (
                <>
                  <span>{latest.facts.numbers.canaries} canaries</span>
                  <span className="text-kept">{latest.facts.numbers.clustersHeld} held</span>
                  <span>{latest.facts.numbers.clustersMoved} moved</span>
                  <span>{latest.facts.numbers.candidatesMeasured} new models measured</span>
                </>
              ) : (
                <span>a short note — published because the measured truth changed</span>
              )}
              <Link href={`/research/${latest.slug}`} className="ml-auto text-accent">read {latest.kind === 'daily' ? 'the note' : 'the issue'} →</Link>
            </div>
          </article>
        ) : (
          <p className="mt-10 border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
            The first issue publishes after the next weekly run. The feed at{' '}
            <Link href="/research/feed.xml" className="text-accent underline">/research/feed.xml</Link> will carry it.
          </p>
        )}

        {/* ---- the measured answers rail ---- */}
        {measured.length > 0 && (
          <section className="mt-12">
            <div className="flex items-baseline justify-between border-b border-[#c4bfb2] pb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              <span>The measured answers · the reference section</span>
              <Link href="/answers" className="text-accent">all →</Link>
            </div>
            <ul className="mt-1">
              {measured.map((p) => {
                const c = answers!.clusters.find((x) => x.clusterId === p.clusterId)!;
                return (
                  <li key={p.slug} className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-dashed border-[#d9d5cb] py-2.5">
                    <Link href={`/answers/${p.slug}`} className="text-[14.5px] font-medium text-ink hover:text-accent">{p.question}</Link>
                    <span className="font-mono text-[10.5px] text-faint">{c.points.length} options · v{c.version} · {c.measuredAt.slice(0, 10)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ---- archive ---- */}
        {rest.length > 0 && (
          <section className="mt-12">
            <div className="border-b border-[#c4bfb2] pb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
              Earlier issues
            </div>
            {rest.map((i) => (
              <article key={i.slug} className="border-b border-dashed border-[#d9d5cb] py-4">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-faint">
                  {i.week} · {i.publishedAt.slice(0, 10)}{i.kind === 'daily' ? ' · daily note' : ''}
                </div>
                <h3 className="mt-1 text-[17px] font-semibold leading-snug tracking-tight text-ink">
                  <Link href={`/research/${i.slug}`} className="hover:text-accent">{i.title}</Link>
                </h3>
                <p className="mt-1 text-[13.5px] leading-relaxed text-soft">{i.summary}</p>
              </article>
            ))}
          </section>
        )}

        <p className="mt-14 font-mono text-[11px] leading-relaxed text-faint">
          Frontier Notes is written by Potion&apos;s own measurement engine and drafted through
          Potion&apos;s own API — each issue carries its receipt. Method:{' '}
          <Link href="/research/methodology" className="text-accent underline">how the numbers are made</Link>.
        </p>
      </main>
    </SiteShell>
  );
}
