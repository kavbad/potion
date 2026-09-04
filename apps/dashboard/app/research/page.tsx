// FRONTIER NOTES — the publication front page (F7, redesigned 2026-09-03).
//
// Editorial magazine STRUCTURE, borrowed from the target the operator named
// (review.firstround.com): a dominant featured piece, a live rail beside it,
// a browsable archive grid with kind tags, and a band that says why this is
// worth reading. STRUCTURE ONLY — the standing design law binds: no serif,
// mono labels ≥12px with tracking pulled in, no floating tiles, the ledger
// identity (double-rule masthead, ledger dividers, receipts aesthetic) is
// Potion's own and stays.
//
// Two editions now share the page (F6): the WEEKLY issue is the feature;
// the DAILY ledger is the rail — a line a day, published whether or not
// anything moved, because a quiet day measured is itself a result.
import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-header';
import { ANSWER_PAGES, fetchPublicAnswers } from '@/lib/answers';
import { listIssues, RESEARCH_TAGLINE, RESEARCH_TITLE, siteOrigin, type Issue } from '@/lib/research';
import { authorSlugForByline } from '@/lib/research-authors';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${RESEARCH_TITLE} — measured model routing research, daily · Potion`,
  description: RESEARCH_TAGLINE,
  alternates: { canonical: '/research', types: { 'application/rss+xml': '/research/feed.xml' } },
  openGraph: { title: RESEARCH_TITLE, description: RESEARCH_TAGLINE, type: 'website', url: '/research' },
};

const isDaily = (i: Issue) => i.kind === 'daily';

function KindTag({ i }: { i: Issue }) {
  const daily = isDaily(i);
  return (
    <span
      className={`border px-1.5 py-px font-mono text-[12px] uppercase tracking-[0.1em] ${
        daily ? 'border-[#c4bfb2] text-faint' : 'border-accent/50 text-accent'
      }`}
    >
      {daily ? 'daily ledger' : 'weekly issue'}
    </span>
  );
}

/** The byline links to the author's page when the author is a fleet worker. */
function Byline({ byline }: { byline: string }) {
  const slug = authorSlugForByline(byline);
  return slug ? (
    <Link href={`/research/authors/${slug}`} className="text-ink underline underline-offset-2 hover:text-accent">
      {byline}
    </Link>
  ) : (
    <span>{byline}</span>
  );
}

export default async function ResearchIndex() {
  const issues = listIssues();
  const origin = siteOrigin();
  const answers = await fetchPublicAnswers();
  const measured = ANSWER_PAGES.filter((p) => answers?.clusters.some((c) => c.clusterId === p.clusterId));

  const weeklies = issues.filter((i) => !isDaily(i));
  const dailies = issues.filter(isDaily);
  // The feature is the newest weekly; if only dailies exist, the newest of those.
  const feature = weeklies[0] ?? issues[0];
  const archive = issues.filter((i) => i.slug !== feature?.slug);
  const verified = issues.filter((i) => i.writer?.verifiedBy).length;

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
      <main className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
        {/* ══ masthead ══ */}
        <header>
          <div className="border-t-2 border-ink" />
          <div className="mt-[3px] border-t border-ink" />
          <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
            <span>by Potion Research</span>
            <span>daily ledger · weekly issue · negatives included</span>
          </div>
          <h1 className="mt-3 text-[3rem] font-semibold leading-[0.98] tracking-[-0.03em] text-ink sm:text-[4.6rem]">
            Frontier Notes
          </h1>
          <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-soft">{RESEARCH_TAGLINE}</p>
          <nav className="mt-5 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] uppercase tracking-[0.1em]">
            <Link href="/answers" className="text-accent underline underline-offset-2">measured answers</Link>
            <Link href="/research/methodology" className="text-accent underline underline-offset-2">methodology</Link>
            <Link href="/research/glossary" className="text-accent underline underline-offset-2">glossary</Link>
            <Link href="/research/authors/delta" className="text-accent underline underline-offset-2">authors</Link>
            <Link href="/research/feed.xml" className="text-accent underline underline-offset-2">rss</Link>
          </nav>
          <div className="mt-6 border-t border-ink" />
          <div className="mt-[3px] border-t-2 border-ink" />
        </header>

        {/* ══ the feature + the daily rail ══ */}
        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section>
            {feature ? (
              <article>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <KindTag i={feature} />
                  <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-faint">
                    {feature.week} · {feature.publishedAt.slice(0, 10)}
                  </span>
                </div>
                <h2 className="mt-4 text-[2.1rem] font-semibold leading-[1.06] tracking-[-0.028em] text-ink sm:text-[2.9rem]">
                  <Link href={`/research/${feature.slug}`} className="hover:text-accent">{feature.title}</Link>
                </h2>
                <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-soft">{feature.summary}</p>
                <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[12px] text-faint">
                  <Byline byline={feature.byline} />
                  {feature.facts && (
                    <>
                      <span>{feature.facts.numbers.canaries} canaries</span>
                      <span className="text-kept">{feature.facts.numbers.clustersHeld} held</span>
                      <span>{feature.facts.numbers.clustersMoved} drifted</span>
                      <span>{feature.facts.numbers.candidatesMeasured} measured</span>
                    </>
                  )}
                  {feature.writer?.verifiedBy && <span className="text-kept">independently verified</span>}
                </div>
                <Link
                  href={`/research/${feature.slug}`}
                  className="mt-6 inline-block border-b-2 border-accent pb-0.5 font-mono text-[13px] uppercase tracking-[0.12em] text-accent hover:text-ink"
                >
                  Read the {isDaily(feature) ? 'ledger' : 'issue'} →
                </Link>
              </article>
            ) : (
              <p className="border border-[#d9d5cb] bg-[#fbfaf7] p-6 text-sm text-soft">
                The first issue publishes after the next measurement run. The feed at{' '}
                <Link href="/research/feed.xml" className="text-accent underline">/research/feed.xml</Link> will carry it.
              </p>
            )}
          </section>

          {/* the daily rail — the thing that changes every day */}
          <aside className="lg:border-l lg:border-[#e2ded4] lg:pl-8">
            <div className="border-b border-ink pb-2 font-mono text-[12px] uppercase tracking-[0.13em] text-ink">
              The daily ledger
            </div>
            <p className="mt-3 text-[13.5px] leading-relaxed text-soft">
              What the instruments did in the last 24 hours — published every day, including the quiet ones.
            </p>
            <ul className="mt-4">
              {dailies.slice(0, 7).map((d) => (
                <li key={d.slug} className="border-b border-dashed border-[#d9d5cb] py-3">
                  <div className="font-mono text-[12px] text-faint">{d.week}</div>
                  <Link href={`/research/${d.slug}`} className="mt-0.5 block text-[14px] font-medium leading-snug text-ink hover:text-accent">
                    {d.title}
                  </Link>
                </li>
              ))}
              {dailies.length === 0 && (
                <li className="py-3 text-[13.5px] leading-relaxed text-faint">
                  The first daily ledger publishes on the next tick.
                </li>
              )}
            </ul>
          </aside>
        </div>

        {/* ══ why this is worth reading — the institution's own claim ══ */}
        <section className="mt-16 border-y border-ink py-8">
          <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-faint">
            Why these numbers are different
          </div>
          <div className="mt-5 grid gap-8 sm:grid-cols-3">
            <div>
              <h3 className="text-[16px] font-semibold text-ink">Measured, not surveyed</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
                Every figure comes from the same measurements that route production traffic. Numbers carry dates, sample sizes and intervals.
              </p>
            </div>
            <div>
              <h3 className="text-[16px] font-semibold text-ink">Written by agents, verified by another</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
                A research worker drafts each piece in a recorded run; a separate integrity worker recomputes its claims before it can publish.{' '}
                {verified > 0 && <>{verified} {verified === 1 ? 'piece has' : 'pieces have'} that record.</>}
              </p>
            </div>
            <div>
              <h3 className="text-[16px] font-semibold text-ink">Negatives included</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
                When a hypothesis fails, the failure is published. A week where nothing moved is reported as a week where nothing moved.
              </p>
            </div>
          </div>
        </section>

        {/* ══ the archive grid ══ */}
        {archive.length > 0 && (
          <section className="mt-14">
            <div className="flex items-baseline justify-between border-b border-[#c4bfb2] pb-2 font-mono text-[12px] uppercase tracking-[0.13em] text-faint">
              <span>The archive</span>
              <span>{weeklies.length} weekly · {dailies.length} daily</span>
            </div>
            <div className="grid gap-x-10 sm:grid-cols-2">
              {archive.map((i) => (
                <article key={i.slug} className="border-b border-dashed border-[#d9d5cb] py-5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <KindTag i={i} />
                    <span className="font-mono text-[12px] text-faint">{i.publishedAt.slice(0, 10)}</span>
                  </div>
                  <h3 className="mt-2 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-ink">
                    <Link href={`/research/${i.slug}`} className="hover:text-accent">{i.title}</Link>
                  </h3>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-soft">{i.summary}</p>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* ══ the reference section ══ */}
        {measured.length > 0 && (
          <section className="mt-14">
            <div className="flex items-baseline justify-between border-b border-[#c4bfb2] pb-2 font-mono text-[12px] uppercase tracking-[0.13em] text-faint">
              <span>The measured answers · reference</span>
              <Link href="/answers" className="text-accent">all →</Link>
            </div>
            <ul className="mt-1">
              {measured.map((p) => {
                const c = answers!.clusters.find((x) => x.clusterId === p.clusterId)!;
                return (
                  <li key={p.slug} className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-dashed border-[#d9d5cb] py-2.5">
                    <Link href={`/answers/${p.slug}`} className="text-[14.5px] font-medium text-ink hover:text-accent">{p.question}</Link>
                    <span className="font-mono text-[12px] text-faint">{c.points.length} options · v{c.version} · {c.measuredAt.slice(0, 10)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <p className="mt-14 max-w-3xl font-mono text-[12px] leading-relaxed text-faint">
          Frontier Notes is produced by Potion Research, a fleet of persistent agents operated on Potion&apos;s own platform: they draft in
          recorded runs, verify each other independently, and publish through the same permission gateway every Potion worker answers to. Each
          piece carries its records. Method:{' '}
          <Link href="/research/methodology" className="text-accent underline">how the numbers are made</Link> ·{' '}
          <Link href="/research/glossary" className="text-accent underline">glossary</Link>.
        </p>
      </main>
    </SiteShell>
  );
}
