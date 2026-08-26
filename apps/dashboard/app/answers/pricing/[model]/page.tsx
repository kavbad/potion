// Per-model pricing page (Answer Engine C2): list prices from the live
// price table PLUS what no pricing page elsewhere has — measured cost per
// 1,000 REQUESTS and measured quality, per workload, from live frontiers.
// Exists only for unmasked models appearing on at least one live frontier.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteShell } from '@/components/site-header';
import { ANSWER_PAGES, fetchPublicAnswers, type PublicModelEntry } from '@/lib/answers';
import { siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ model: string }> };

async function load(model: string): Promise<{ entry: PublicModelEntry; generatedAt: string } | null> {
  const data = await fetchPublicAnswers();
  const entry = data?.models.find((m) => m.slug === model) ?? null;
  return entry && data ? { entry, generatedAt: data.generatedAt } : null;
}

function verdict(entry: PublicModelEntry): string {
  const best = [...entry.appearances].sort((a, b) => b.quality - a.quality)[0]!;
  const cheapest = [...entry.appearances].sort((a, b) => a.costPer1K - b.costPer1K)[0]!;
  const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
  return (
    `${entry.label} costs $${entry.inputPer1M.toFixed(2)} per million input tokens and $${entry.outputPer1M.toFixed(2)} per million output ` +
    `tokens. On Potion's live measurements it runs from ${money(cheapest.costPer1K)} per 1,000 requests, and its strongest ` +
    `measured workload is ${best.clusterName.toLowerCase()} (quality ${best.quality.toFixed(3)}).`
  );
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { model } = await params;
  const found = await load(model);
  if (!found) return { title: 'Not measured · Frontier Notes', robots: { index: false } };
  const { entry } = found;
  return {
    title: `${entry.label} pricing & measured cost per request · Frontier Notes`,
    description: verdict(entry),
    alternates: { canonical: `/answers/pricing/${entry.slug}` },
    openGraph: { title: `${entry.label} pricing, measured`, description: verdict(entry), type: 'article', siteName: 'Potion' },
  };
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default async function ModelPricingPage({ params }: Params) {
  const { model } = await params;
  const found = await load(model);
  if (!found) notFound();
  const { entry } = found;
  const origin = siteOrigin();
  const url = `${origin}/answers/pricing/${entry.slug}`;
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: `${entry.label} pricing and measured cost per request`,
      description: verdict(entry),
      author: { '@type': 'Organization', name: 'Potion Research', url: `${origin}/research` },
      publisher: { '@type': 'Organization', name: 'Potion', url: origin },
      mainEntityOfPage: url,
      url,
      isPartOf: { '@type': 'Blog', name: 'Frontier Notes', url: `${origin}/research` },
    },
  ];
  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <nav className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          <Link href="/answers" className="hover:text-accent">The Measured Answers</Link>
          {' · '}<Link href="/answers/pricing" className="hover:text-accent">pricing</Link>
        </nav>
        <h1 className="mt-4 text-3xl font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.4rem]">
          {entry.label} pricing{entry.vendor ? ` (${entry.vendor})` : ''}
        </h1>

        <section className="mt-7 border border-accent/40 bg-[#fbfaf7] px-6 py-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-accent">the measured answer</div>
          <p className="mt-2 text-[17px] leading-relaxed text-ink">{verdict(entry)}</p>
          <p className="mt-2 font-mono text-[11px] text-faint">
            per-token list price + measured per-request cost from live traffic-shaped suites ·{' '}
            <Link href="/research/methodology" className="text-accent underline">method</Link>
          </p>
        </section>

        <p className="mt-8 text-[15px] leading-relaxed text-soft">
          Per-token prices say little about what a request costs: input/output profiles differ per
          workload, and reasoning-style models spend hidden tokens. The table below is the number a
          bill is made of — measured cost per 1,000 requests, with the measured quality it buys,
          per kind of work this model appears on the live frontier for.
        </p>

        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden border border-[#d9d5cb] bg-[#d9d5cb]">
          <div className="bg-[#fbfaf7] px-4 py-3">
            <div className="font-mono text-[1.15rem] font-semibold tabular-nums text-ink">${entry.inputPer1M.toFixed(2)}</div>
            <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">per 1M input tokens</div>
          </div>
          <div className="bg-[#fbfaf7] px-4 py-3">
            <div className="font-mono text-[1.15rem] font-semibold tabular-nums text-ink">${entry.outputPer1M.toFixed(2)}</div>
            <div className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-faint">per 1M output tokens</div>
          </div>
        </div>

        <h2 className="mt-10 text-xl font-semibold tracking-tight text-ink">Measured, per kind of work</h2>
        <div className="mt-4 overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7]">
          <table className="w-full text-left font-mono text-[12.5px]">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-normal">kind of work</th>
                <th className="px-4 py-2.5 text-right font-normal">measured quality</th>
                <th className="px-4 py-2.5 text-right font-normal">$ / 1K requests</th>
                <th className="px-4 py-2.5 text-right font-normal">p95 latency</th>
                <th className="px-4 py-2.5 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {entry.appearances.map((a) => {
                const page = ANSWER_PAGES.find((p) => p.clusterId === a.clusterId);
                return (
                  <tr key={a.clusterId} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2 text-ink">{a.clusterName}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{a.quality.toFixed(3)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{money(a.costPer1K)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-soft">{Math.round(a.latencyP95)} ms</td>
                    <td className="px-4 py-2 text-right">
                      {page && <Link href={`/answers/${page.slug}`} className="text-accent underline">frontier →</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-faint">
          a model appears here only for workloads where it sits on the live measured frontier —
          absence means it was measured and beaten, or not yet measured
        </p>

        <section className="mt-10 border border-[#d9d5cb] bg-[#fbfaf7] px-6 py-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">the routed alternative</div>
          <p className="mt-2 text-[14.5px] leading-relaxed text-soft">
            Potion routes each request to the cheapest option measured at your quality bar — this
            model where it earns the route, something cheaper where it does not.{' '}
            <Link href="/login" className="text-accent underline">Get an API key</Link>.
          </p>
        </section>
      </main>
    </SiteShell>
  );
}
