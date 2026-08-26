// Pairwise comparison page (Answer Engine C2): "[A] vs [B] for <workload>",
// generated ONLY where both sides are unmasked live measurements on the same
// frontier — the scaled-content rule structurally: no measured pair, no page.
// The unique data is the pair's measured rows; the verdict is generated from
// them; the workload framing is the cluster's hand-written intro.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteShell } from '@/components/site-header';
import {
  answerPageBySlug,
  comparisonVerdict,
  fetchPublicAnswers,
  pairByVersus,
  type ComparisonPair,
  type PublicAnswerCluster,
} from '@/lib/answers';
import { siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string; versus: string }> };

async function load(slug: string, versus: string): Promise<{ page: NonNullable<ReturnType<typeof answerPageBySlug>>; cluster: PublicAnswerCluster; pair: ComparisonPair } | null> {
  const page = answerPageBySlug(slug);
  if (!page) return null;
  const data = await fetchPublicAnswers();
  const cluster = data?.clusters.find((c) => c.clusterId === page.clusterId) ?? null;
  if (!cluster) return null;
  const pair = pairByVersus(cluster, versus);
  if (!pair) return null;
  return { page, cluster, pair };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, versus } = await params;
  const found = await load(slug, versus);
  if (!found) return { title: 'Not measured · Frontier Notes', robots: { index: false } };
  const { page, cluster, pair } = found;
  const title = `${pair.a.label} vs ${pair.b.label} for ${page.short}`;
  return {
    title: `${title} — measured · Frontier Notes`,
    description: comparisonVerdict(cluster, pair),
    alternates: { canonical: `/answers/${page.slug}/${pair.versus}` },
    openGraph: { title, description: comparisonVerdict(cluster, pair), type: 'article', modifiedTime: cluster.measuredAt, siteName: 'Potion' },
  };
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default async function ComparisonPage({ params }: Params) {
  const { slug, versus } = await params;
  const found = await load(slug, versus);
  if (!found) notFound();
  const { page, cluster, pair } = found;
  const origin = siteOrigin();
  const url = `${origin}/answers/${page.slug}/${pair.versus}`;
  const verdict = comparisonVerdict(cluster, pair);
  const rows = [pair.a, pair.b];

  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: `${pair.a.label} vs ${pair.b.label} for ${page.short}`,
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
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'The Measured Answers', item: `${origin}/answers` },
        { '@type': 'ListItem', position: 2, name: page.question, item: `${origin}/answers/${page.slug}` },
        { '@type': 'ListItem', position: 3, name: `${pair.a.label} vs ${pair.b.label}`, item: url },
      ],
    },
  ];

  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <nav className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          <Link href="/answers" className="hover:text-accent">The Measured Answers</Link>
          {' · '}<Link href={`/answers/${page.slug}`} className="hover:text-accent">{page.short}</Link>
        </nav>
        <h1 className="mt-4 text-3xl font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.4rem]">
          {pair.a.label} vs {pair.b.label} for {page.short}
        </h1>

        <section className="mt-7 border border-accent/40 bg-[#fbfaf7] px-6 py-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">the measured answer</div>
          <p className="mt-2 text-[17px] leading-relaxed text-ink">{verdict}</p>
          <p className="mt-2 font-mono text-[11px] text-faint">
            same suite, same items, same scoring — frontier v{cluster.version}, measured {cluster.measuredAt.slice(0, 10)} ·{' '}
            <Link href="/research/methodology" className="text-accent underline">method</Link>
          </p>
        </section>

        <div className="mt-8 overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7]">
          <table className="w-full text-left font-mono text-[12.5px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-normal">model</th>
                <th className="px-4 py-2.5 font-normal">vendor</th>
                <th className="px-4 py-2.5 text-right font-normal">measured quality</th>
                <th className="px-4 py-2.5 text-right font-normal">$ / 1K requests</th>
                <th className="px-4 py-2.5 text-right font-normal">p95 latency</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.slug} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2 text-ink">{p.label}</td>
                  <td className="px-4 py-2 text-soft">{p.vendor ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink">{p.quality.toFixed(3)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink">{money(p.costPer1K)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-soft">{Math.round(p.latencyP95)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-8 text-[15px] leading-relaxed text-soft">{page.intro}</p>

        <p className="mt-6 text-[14px] leading-relaxed text-soft">
          These two are part of a larger measured frontier —{' '}
          <Link href={`/answers/${page.slug}`} className="text-accent underline">{page.question.toLowerCase().replace(/\?$/, '')}</Link>{' '}
          shows every measured option for this workload, and other workloads rank these models
          differently: a model that wins here can lose on another kind of work, which is the whole
          argument for routing per workload rather than picking one model for everything.
        </p>

        <section className="mt-10 border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">the routed alternative</div>
          <p className="mt-2 text-[14.5px] leading-relaxed text-soft">
            Potion routes each request to the cheapest option measured at your quality bar — including
            picks this public page does not name.{' '}
            <Link href="/login" className="text-accent underline">Get an API key</Link> or read the{' '}
            <Link href="/docs" className="text-accent underline">docs</Link>.
          </p>
        </section>

        <nav className="mt-12 border-t border-line pt-5 font-mono text-[12px] text-faint">
          <Link href={`/answers/${page.slug}`} className="text-accent hover:underline">← every measured option for {page.short}</Link>
          {' · '}<Link href="/research/methodology" className="text-accent hover:underline">methodology</Link>
        </nav>
      </main>
    </SiteShell>
  );
}
