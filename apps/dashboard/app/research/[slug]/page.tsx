import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteShell } from '@/components/site-header';
import { getIssue, listIssues, RESEARCH_TITLE, siteOrigin } from '@/lib/research';
import { authorSlugForByline } from '@/lib/research-authors';
import { DEFAULT_ISSUE_CTA } from '@/lib/research-ctas';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const i = getIssue(slug);
  if (!i) return { title: `Not found · ${RESEARCH_TITLE}` };
  return {
    title: `${i.title} · ${RESEARCH_TITLE}`,
    description: i.summary,
    alternates: { canonical: `/research/${i.slug}` },
    openGraph: { title: i.title, description: i.summary, type: 'article', publishedTime: i.publishedAt, url: `/research/${i.slug}`, siteName: 'Potion' },
    twitter: { card: 'summary', title: i.title, description: i.summary },
  };
}

const q3 = (x: number) => x.toFixed(3);
// 'drifted', never 'moved': drift = the canary left its stored interval;
// the routed pick did NOT change (the verdict-semantics law, 2026-09-02).
const verdictWord = (v: string) => (v === 'ok' ? 'held' : v === 'drift' ? 'drifted' : 'inconclusive');

export default async function IssuePage({ params }: Params) {
  const { slug } = await params;
  const i = getIssue(slug);
  if (!i) notFound();

  // C3: a DAILY note renders compact — masthead, verdict, body paragraphs —
  // never the weekly scaffolding (whose sections would be hollow).
  if (i.kind === 'daily' || !i.facts) {
    const origin2 = siteOrigin();
    const url2 = `${origin2}/research/${i.slug}`;
    const dailyLd = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: i.title,
      description: i.summary,
      datePublished: i.publishedAt,
      dateModified: i.publishedAt,
      author: { '@type': 'Organization', name: 'Potion Research', url: `${origin2}/research` },
      publisher: { '@type': 'Organization', name: 'Potion', url: origin2 },
      mainEntityOfPage: url2,
      url: url2,
      isPartOf: { '@type': 'Blog', name: RESEARCH_TITLE, url: `${origin2}/research` },
    };
    return (
      <SiteShell current="research">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(dailyLd) }} />
        <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
          <header>
            <div className="border-t-2 border-ink" />
            <div className="mt-[3px] border-t border-ink" />
            <nav className="mt-4 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
              <Link href="/research" className="text-ink hover:text-accent">{RESEARCH_TITLE}</Link>
              <span>daily note · {i.publishedAt.slice(0, 10)}</span>
            </nav>
          </header>
          <h1 className="mt-6 text-[1.9rem] font-semibold leading-[1.1] tracking-[-0.02em] text-ink sm:text-[2.4rem]">{i.title}</h1>
          <div className="mt-3 font-mono text-[12px] text-faint">{i.byline}</div>
          {(i.body ?? i.summary).split('\n\n').map((para) => (
            <p key={para.slice(0, 40)} className="mt-6 text-[16px] leading-relaxed text-ink">{para}</p>
          ))}
          <p className="mt-8 border-t border-dashed border-[#d9d5cb] pt-4 text-[13.5px] leading-relaxed text-soft">
            {/* The byline is a provenance claim, and a daily piece earns it
                the same way a weekly one does — the run id is the receipt. */}
            {i.writer?.runId ? (
              <>
                Written by {i.byline} in a recorded worker run (
                <span className="font-mono text-[12.5px] text-ink">{i.writer.runId}</span>)
                {i.writer.verifiedBy ? <>, verified by Auditor (<span className="font-mono text-[12.5px] text-ink">{i.writer.verifiedBy.runId}</span>)</> : null}.{' '}
              </>
            ) : null}
            The current numbers live on{' '}
            <Link href="/answers" className="text-accent underline">the measured answers</Link>; the method is{' '}
            <Link href="/research/methodology" className="text-accent underline">public</Link>.
          </p>
          <nav className="mt-10 border-t border-line pt-5 font-mono text-[12px]">
            <Link href="/research" className="text-accent hover:underline">← all of Frontier Notes</Link>
          </nav>
        </main>
      </SiteShell>
    );
  }

  const f = i.facts;
  const origin = siteOrigin();
  const url = `${origin}/research/${i.slug}`;
  const all = listIssues();
  const idx = all.findIndex((x) => x.slug === i.slug);
  const newer = idx > 0 ? all[idx - 1] : null;
  const older = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: i.title,
      description: i.summary,
      datePublished: i.publishedAt,
      dateModified: i.publishedAt,
      author: { '@type': 'Organization', name: i.byline, url: `${origin}/research` },
      publisher: { '@type': 'Organization', name: 'Potion', url: origin },
      mainEntityOfPage: url,
      url,
      isPartOf: { '@type': 'Blog', name: RESEARCH_TITLE, url: `${origin}/research` },
      about: ['AI model routing', 'LLM cost optimization', 'Pareto frontier', 'model evaluation'],
      keywords: 'measured model routing, cheapest LLM by quality, AI cost per 1000 requests, model drift, model mixing',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `Routing frontier canaries, ${i.week}`,
      description: `Weekly drift check of ${f.numbers.canaries} routing frontiers: stored quality with 95% interval and the observed canary mean for each cluster of work.`,
      url,
      creator: { '@type': 'Organization', name: 'Potion' },
      temporalCoverage: i.week,
      variableMeasured: ['quality', 'quality 95% interval', 'observed canary mean', 'verdict'],
      license: 'https://creativecommons.org/licenses/by/4.0/',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: i.faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })),
    },
  ];

  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <header>
          <div className="border-t-2 border-ink" />
          <div className="mt-[3px] border-t border-ink" />
          <nav className="mt-4 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
            <Link href="/research" className="text-ink hover:text-accent">{RESEARCH_TITLE}</Link>
            <span>{i.week} · {i.publishedAt.slice(0, 10)}</span>
          </nav>
        </header>
        <h1 className="mt-6 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em] text-ink sm:text-[2.9rem]">{i.title}</h1>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px] text-faint">
          {authorSlugForByline(i.byline) ? (
            <Link href={`/research/authors/${authorSlugForByline(i.byline)}`} className="text-ink underline underline-offset-2 hover:text-accent">{i.byline}</Link>
          ) : (
            <span>{i.byline}</span>
          )}
          <span>·</span>
          <Link href="/research/methodology" className="text-accent underline underline-offset-2">method</Link>
          <span>·</span>
          <Link href="/research/glossary" className="text-accent underline underline-offset-2">glossary</Link>
          <span>·</span>
          <Link href="/answers" className="text-accent underline underline-offset-2">the measured answers</Link>
        </div>

        <section className="mt-8 rounded-2xl border border-accent/30 bg-accent-soft/40 px-6 py-5">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-accent">In plain words</div>
          <p className="mt-2 text-[17px] leading-relaxed text-ink">{i.plain}</p>
        </section>

        <p className="mt-8 text-lg leading-relaxed text-ink">{i.lede}</p>

        <h2 className="mt-14 text-xl font-semibold tracking-tight text-ink">This week&apos;s frontiers</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-soft">
          One row per kind of work. <span className="text-ink">Routed pick</span> is the model Potion currently sends that work to.{' '}
          <span className="text-ink">Stored quality</span> is its exam score when it was measured in full, give or take the margin.{' '}
          <span className="text-ink">Canary</span> is this week&apos;s small re-check: a few fresh tasks, scored the same way, to catch a model that has got worse.{' '}
          <span className="text-ink">Held</span> means the re-check landed inside the margin.
        </p>
        <div className="mt-4 overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7]">
          <table className="w-full text-left font-mono text-[12px]">
            <thead className="text-[11.5px] uppercase tracking-[0.14em] text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-normal">kind of work</th>
                <th className="px-4 py-2.5 font-normal">verdict</th>
                <th className="px-4 py-2.5 font-normal">routed pick</th>
                <th className="px-4 py-2.5 font-normal">stored quality</th>
                <th className="px-4 py-2.5 font-normal">canary</th>
              </tr>
            </thead>
            <tbody>
              {f.frontier.map((c) => (
                <tr key={c.clusterId} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2 text-ink">{c.clusterId}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block border px-1.5 py-px text-[11.5px] uppercase tracking-[0.1em] ${c.verdict === 'drift' ? 'border-refuse text-refuse' : c.verdict === 'ok' ? 'border-kept text-kept' : 'border-line text-faint'}`}>
                      {verdictWord(c.verdict)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-ink">{c.pick}</td>
                  <td className="px-4 py-2 text-soft">{q3(c.storedQuality)} ± {q3(c.storedCi95)}</td>
                  <td className="px-4 py-2 text-soft">{c.observedMean === null ? '—' : q3(c.observedMean)} <span className="text-faint">n={c.n}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-[15px] leading-relaxed text-soft">{i.frontierNote}</p>

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Auditions</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-soft">An audition is a newly released model&apos;s first exam, on the kind of work it looks suited to. It earns a place only by beating the model already doing that work on quality or price.</p>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">{i.auditionNote}</p>
        {f.auditions.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-[12px] text-soft">
            {f.auditions.map((a) => (
              <li key={`${a.alias}-${a.clusterId}`}>{a.alias} · {a.lane} · {a.clusterId} · {a.outcome}</li>
            ))}
          </ul>
        )}

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Mixing</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-soft">Mixing means using two or three cheaper models together in a particular way instead of one expensive one. We score combinations by replaying results we already have, so this costs nothing to explore. How a combination works is part of the product and is not published; what it achieves is.</p>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">{i.mixingNote}</p>
        {f.mixing.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-[12px] text-soft">
            {f.mixing.map((m) => (
              <li key={(m.clusterId ?? m.family) + m.kind}>
                {m.vague ? `${m.family} work` : m.clusterId} · {m.kind} · quality {q3(m.meanQuality)} · {m.vague ? m.costBand : `${Math.round(m.costSaving * 100)}% cheaper`} · n={m.n}
              </li>
            ))}
          </ul>
        )}

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">What it means for you</h2>
        <p className="mt-3 text-[16px] leading-relaxed text-ink">{i.takeaway}</p>

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">How the numbers are made</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">{i.method}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-soft">
          {f.caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Numbers</h2>
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden border border-[#d9d5cb] bg-[#d9d5cb] sm:grid-cols-4">
          {[
            [String(f.numbers.canaries), 'canaries run'],
            [String(f.numbers.clustersHeld), 'frontiers held'],
            [String(f.numbers.clustersMoved), 'frontiers drifted'],
            [String(f.numbers.itemsGraded), 'items graded'],
            [String(f.numbers.candidatesScreened), 'listings screened'],
            [String(f.numbers.candidatesMeasured), 'new models measured'],
            [String(f.numbers.inconclusive), 'inconclusive'],
            [`$${f.numbers.spendUsd.toFixed(2)}`, 'measurement spend'],
          ].map(([n, l]) => (
            <div key={l} className="bg-[#fbfaf7] px-4 py-3">
              <div className="font-mono text-[1.15rem] font-semibold tabular-nums text-ink">{n}</div>
              <div className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-faint">{l}</div>
            </div>
          ))}
        </div>

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Questions</h2>
        <dl className="mt-4 space-y-5">
          {i.faq.map((x) => (
            <div key={x.q}>
              <dt className="font-medium text-ink">{x.q}</dt>
              <dd className="mt-1 text-[15px] leading-relaxed text-soft">{x.a}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-12 text-[13px] leading-relaxed text-soft">
          <span className="font-medium text-ink">Glossary.</span> A <em>frontier</em> is the short list of models that are the best deal at their level of quality: nothing else is both better and cheaper. A <em>floor</em> is the lowest exam score you are willing to accept. A <em>margin</em> (or interval) is how far the true score could sit from the measured one, because an exam is a sample. A <em>canary</em> is a small weekly re-check. See the <Link href="/docs" className="text-accent underline">docs</Link> and the <Link href="/home#evidence" className="text-accent underline">evidence</Link>.
        </p>

        {/* F0 (docs/RESEARCH-FLEET.md R2): a Delta-written issue shows the
            RUN that backs the byline — credits derive from records. */}
        {i.writer?.runId && (
          <div className="mt-10 border border-dashed border-[#b8b3a6] bg-[#fbfaf7] px-5 py-4">
            <div className="flex items-baseline justify-between font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
              <span>{i.byline} · run record</span>
              <span className="border border-kept px-1.5 py-px text-kept">recorded</span>
            </div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
              This issue was written by <span className="font-medium text-ink">{i.byline}</span>, a persistent Potion worker, in a recorded run —{' '}
              <span className="font-mono text-ink">{i.writer.runId}</span>. The byline is a provenance claim the record backs: the draft, every
              tool step, and the judge&apos;s verdict are on the run.
              {i.writer.verifiedBy && (
                <>
                  {' '}Verified by <span className="font-medium text-ink">Auditor</span>, a Potion research-integrity worker, in a recorded run —{' '}
                  <span className="font-mono text-ink">{i.writer.verifiedBy.runId}</span>: the draft published only after its claims were independently recomputed against the fact sheet.
                </>
              )}{' '}
              We use what we sell.
            </p>
          </div>
        )}
        {i.writer?.receipt && (
          <div className="mt-10 border border-dashed border-[#b8b3a6] bg-[#fbfaf7] px-5 py-4">
            <div className="flex items-baseline justify-between font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
              <span>Potion · receipt</span>
              <span className="border border-kept px-1.5 py-px text-kept">served</span>
            </div>
            <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
              This issue was drafted by sending one request to Potion&apos;s own API, the same way a customer would. The receipt that came back: kind of work{' '}
              <span className="font-mono text-ink">{i.writer.receipt.cluster}</span>, strategy <span className="font-mono text-ink">{i.writer.receipt.strategy8}</span>, policy{' '}
              <span className="font-mono text-ink">{i.writer.receipt.policy}</span>, {i.writer.receipt.promptTokens + i.writer.receipt.completionTokens} tokens. We use what we sell.
            </p>
          </div>
        )}

        {/* E7: the CTA answers the reader's natural next question and
            resolves to a LIVE surface from the registry — never invented. */}
        <div className="mt-12 border-t border-line pt-8">
          <p className="font-mono text-[12px] uppercase tracking-[0.13em] text-faint">{DEFAULT_ISSUE_CTA.question}</p>
          <Link href={DEFAULT_ISSUE_CTA.href} className="mt-2 inline-block text-[17px] font-medium text-accent underline underline-offset-4 hover:text-ink">
            {DEFAULT_ISSUE_CTA.label}
          </Link>
        </div>

        <nav className="mt-14 flex justify-between border-t border-line pt-6 font-mono text-[12px]">
          <span>{older ? <Link href={`/research/${older.slug}`} className="text-accent hover:underline">← {older.week}</Link> : null}</span>
          <span>{newer ? <Link href={`/research/${newer.slug}`} className="text-accent hover:underline">{newer.week} →</Link> : null}</span>
        </nav>
      </main>
    </SiteShell>
  );
}
