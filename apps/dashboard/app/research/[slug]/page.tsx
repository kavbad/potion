import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteShell } from '@/components/site-header';
import { getIssue, listIssues, RESEARCH_TITLE, siteOrigin } from '@/lib/research';

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
const verdictWord = (v: string) => (v === 'ok' ? 'held' : v === 'drift' ? 'moved' : 'inconclusive');

export default async function IssuePage({ params }: Params) {
  const { slug } = await params;
  const i = getIssue(slug);
  if (!i) notFound();
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
        <nav className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          <Link href="/research" className="hover:text-accent">{RESEARCH_TITLE}</Link> · {i.week} · {i.publishedAt.slice(0, 10)}
        </nav>
        <h1 className="mt-4 text-3xl font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">{i.title}</h1>
        <div className="mt-4 font-mono text-[11px] text-faint">{i.byline}</div>
        <p className="mt-8 text-lg leading-relaxed text-ink">{i.lede}</p>

        <h2 className="mt-14 text-xl font-semibold tracking-tight text-ink">This week&apos;s frontiers</h2>
        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full text-left font-mono text-[12px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-normal">cluster</th>
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
                  <td className={`px-4 py-2 ${c.verdict === 'drift' ? 'text-red-700' : c.verdict === 'ok' ? 'text-accent' : 'text-faint'}`}>{verdictWord(c.verdict)}</td>
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
        <p className="mt-3 text-[15px] leading-relaxed text-soft">{i.auditionNote}</p>
        {f.auditions.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-[12px] text-soft">
            {f.auditions.map((a) => (
              <li key={`${a.alias}-${a.clusterId}`}>{a.alias} · {a.lane} · {a.clusterId} · {a.outcome}</li>
            ))}
          </ul>
        )}

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Mixing</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">{i.mixingNote}</p>
        {f.mixing.length > 0 && (
          <ul className="mt-3 space-y-1 font-mono text-[12px] text-soft">
            {f.mixing.map((m) => (
              <li key={m.clusterId + m.kind}>
                {m.vague ? `${m.family} work` : m.clusterId} · {m.kind} · quality {q3(m.meanQuality)} · {m.vague ? m.costBand : `${Math.round(m.costSaving * 100)}% cheaper`} · n={m.n}
              </li>
            ))}
          </ul>
        )}

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Method</h2>
        <p className="mt-3 text-[15px] leading-relaxed text-soft">{i.method}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-soft">
          {f.caveats.map((c) => <li key={c}>{c}</li>)}
        </ul>

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Numbers</h2>
        <p className="mt-3 font-mono text-[12px] leading-relaxed text-soft">
          {f.numbers.canaries} canaries · {f.numbers.clustersHeld} held · {f.numbers.clustersMoved} moved · {f.numbers.inconclusive} inconclusive · {f.numbers.itemsGraded} items graded ·{' '}
          {f.numbers.candidatesScreened} listings screened · {f.numbers.candidatesMeasured} measured · ${f.numbers.spendUsd.toFixed(2)} spent
        </p>

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
          <span className="font-medium text-ink">Glossary.</span> A <em>frontier</em> is the set of model options nothing else beats on quality, cost and latency at once. A <em>floor</em> is the lowest quality a routing policy will accept. An <em>interval</em> is the bootstrap 95% range around a measured mean. See the <Link href="/docs" className="text-accent underline">docs</Link> and the <Link href="/home#evidence" className="text-accent underline">evidence</Link>.
        </p>

        <nav className="mt-14 flex justify-between border-t border-line pt-6 font-mono text-[12px]">
          <span>{older ? <Link href={`/research/${older.slug}`} className="text-accent hover:underline">← {older.week}</Link> : null}</span>
          <span>{newer ? <Link href={`/research/${newer.slug}`} className="text-accent hover:underline">{newer.week} →</Link> : null}</span>
        </nav>
      </main>
    </SiteShell>
  );
}
