// One measured answer page (Answer Engine C1): the question as the H1, a
// dated extractable verdict, the live-measured table, hand-written framing,
// and question-form FAQs. Server-rendered; exists ONLY for clusters with
// live measurements (thin combinations are never generated — the 2026
// scaled-content rule, applied literally).
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteShell } from '@/components/site-header';
import { answerPageBySlug, comparisonPairs, fetchPublicAnswers, verdictFor, type PublicAnswerCluster } from '@/lib/answers';
import { siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

async function clusterFor(slug: string): Promise<{ page: NonNullable<ReturnType<typeof answerPageBySlug>>; cluster: PublicAnswerCluster } | null> {
  const page = answerPageBySlug(slug);
  if (!page) return null;
  const data = await fetchPublicAnswers();
  const cluster = data?.clusters.find((c) => c.clusterId === page.clusterId) ?? null;
  if (!cluster) return null;
  return { page, cluster };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const found = await clusterFor(slug);
  if (!found) return { title: 'Not measured yet · Frontier Notes', robots: { index: false } };
  const { page, cluster } = found;
  const month = new Date(cluster.measuredAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  return {
    title: `${page.question} Measured ${month} · Frontier Notes`,
    description: verdictFor(cluster),
    alternates: { canonical: `/answers/${page.slug}` },
    openGraph: { title: page.question, description: verdictFor(cluster), type: 'article', modifiedTime: cluster.measuredAt, url: `/answers/${page.slug}`, siteName: 'Potion' },
    twitter: { card: 'summary', title: page.question, description: verdictFor(cluster) },
  };
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default async function AnswerPage({ params }: Params) {
  const { slug } = await params;
  const found = await clusterFor(slug);
  if (!found) notFound();
  const { page, cluster } = found;
  const origin = siteOrigin();
  const url = `${origin}/answers/${page.slug}`;
  const verdict = verdictFor(cluster);
  const top = cluster.points.reduce((m, p) => Math.max(m, p.quality), 0);

  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: page.question,
      description: verdict,
      dateModified: cluster.measuredAt,
      author: { '@type': 'Organization', name: 'Potion Research', url: `${origin}/research` },
      publisher: { '@type': 'Organization', name: 'Potion', url: origin },
      mainEntityOfPage: url,
      url,
      isPartOf: { '@type': 'Blog', name: 'Frontier Notes', url: `${origin}/research` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `Measured ${cluster.name.toLowerCase()} frontier, v${cluster.version}`,
      description: `Live-measured quality, cost per 1,000 requests, and p95 latency for ${cluster.points.length} options on ${cluster.name.toLowerCase()} work.`,
      url,
      dateModified: cluster.measuredAt,
      creator: { '@type': 'Organization', name: 'Potion' },
      variableMeasured: ['quality', 'cost per 1K requests (USD)', 'p95 latency (ms)'],
      license: 'https://creativecommons.org/licenses/by/4.0/',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Frontier Notes', item: `${origin}/research` },
        { '@type': 'ListItem', position: 2, name: 'The Measured Answers', item: `${origin}/answers` },
        { '@type': 'ListItem', position: 3, name: page.question, item: url },
      ],
    },
  ];

  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <nav className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
          <Link href="/research" className="hover:text-accent">Frontier Notes</Link>
          {' · '}<Link href="/answers" className="hover:text-accent">The Measured Answers</Link>
        </nav>
        <h1 className="mt-4 text-3xl font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">{page.question}</h1>

        {/* The extractable verdict — dated, numeric, ≤ a breath. */}
        <section className="mt-7 border border-accent/40 bg-[#fbfaf7] px-6 py-5">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-accent">the measured answer</div>
          <p className="mt-2 text-[17px] leading-relaxed text-ink">{verdict}</p>
          <p className="mt-2 font-mono text-[12px] text-faint">
            re-measured weekly · <Link href="/research/methodology" className="text-accent underline">how these numbers are made</Link>
          </p>
        </section>

        <p className="mt-8 text-[15.5px] leading-relaxed text-soft">{page.intro}</p>

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">The measured frontier</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-soft">
          Every row is a live measurement on Potion&apos;s held-out {cluster.name.toLowerCase()} suite —
          same items, same scoring, per option. Names that are part of the product are withheld;
          their numbers are not.
        </p>
        <div className="mt-4 overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7]">
          <table className="w-full text-left font-mono text-[12.5px]">
            <thead className="text-[11.5px] uppercase tracking-[0.14em] text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-normal">option</th>
                <th className="px-4 py-2.5 font-normal">vendor</th>
                <th className="px-4 py-2.5 text-right font-normal">measured quality</th>
                <th className="px-4 py-2.5 text-right font-normal">$ / 1K requests</th>
                <th className="px-4 py-2.5 text-right font-normal">p95 latency</th>
              </tr>
            </thead>
            <tbody>
              {cluster.points.map((p) => (
                <tr key={`${p.label}-${p.costPer1K}`} className="border-b border-line/60 last:border-0">
                  <td className={`px-4 py-2 ${p.masked ? 'text-soft italic' : 'text-ink'}`}>{p.label}</td>
                  <td className="px-4 py-2 text-soft">{p.vendor ?? '—'}</td>
                  <td className={`px-4 py-2 text-right tabular-nums ${p.quality === top ? 'font-semibold text-ink' : 'text-soft'}`}>{p.quality.toFixed(3)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink">{money(p.costPer1K)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-soft">{Math.round(p.latencyP95)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 font-mono text-[12px] leading-relaxed text-faint">
          frontier v{cluster.version} · measured {cluster.measuredAt.slice(0, 10)} · live provider calls only —
          simulated evidence never appears on this page
        </p>

        {comparisonPairs(cluster).length > 0 && (
          <>
            <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Head to head</h2>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[13.5px]">
              {comparisonPairs(cluster).map((pr) => (
                <Link key={pr.versus} href={`/answers/${page.slug}/${pr.versus}`} className="text-accent underline underline-offset-2">
                  {pr.a.label} vs {pr.b.label}
                </Link>
              ))}
            </p>
          </>
        )}

        <h2 className="mt-12 text-xl font-semibold tracking-tight text-ink">Questions</h2>
        <div className="mt-4 space-y-6">
          {page.faqs.map((f) => (
            <section key={f.q}>
              <h3 className="text-[16px] font-medium text-ink">{f.q}</h3>
              <p className="mt-1 text-[15px] leading-relaxed text-soft">{f.a}</p>
            </section>
          ))}
        </div>

        <section className="mt-12 border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-5">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">the routed alternative</div>
          <p className="mt-2 text-[14.5px] leading-relaxed text-soft">
            Potion routes each request to the cheapest option measured at your quality bar — with a
            receipt on every answer and this page&apos;s evidence behind every pick.{' '}
            <Link href="/login" className="text-accent underline">Get an API key</Link> or read the{' '}
            <Link href="/docs" className="text-accent underline">docs</Link>.
          </p>
        </section>

        <nav className="mt-12 border-t border-line pt-5 font-mono text-[12px] text-faint">
          <Link href="/answers" className="text-accent hover:underline">← all measured answers</Link>
          {' · '}<Link href="/research" className="text-accent hover:underline">the weekly issues</Link>
          {' · '}<Link href="/research/methodology" className="text-accent hover:underline">methodology</Link>
        </nav>
      </main>
    </SiteShell>
  );
}
