// Pricing index (Answer Engine C2): every unmasked model on a live
// frontier, list price + measured per-request range, linking to its page.
import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-header';
import { fetchPublicAnswers } from '@/lib/answers';
import { siteOrigin } from '@/lib/research';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Model pricing, measured per request · Frontier Notes',
  description:
    'List prices per million tokens plus what no pricing table elsewhere has: live-measured cost per 1,000 requests and the measured quality it buys, per kind of work.',
  alternates: { canonical: '/answers/pricing' },
};

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export default async function PricingIndex() {
  const data = await fetchPublicAnswers();
  const models = data?.models ?? [];
  const origin = siteOrigin();
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Model pricing, measured per request',
    url: `${origin}/answers/pricing`,
    isPartOf: { '@type': 'Blog', name: 'Frontier Notes', url: `${origin}/research` },
    publisher: { '@type': 'Organization', name: 'Potion', url: origin },
  };
  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <div className="font-mono text-xs uppercase tracking-[0.14em] text-faint">
          <Link href="/answers" className="hover:text-accent">The Measured Answers</Link> · pricing
        </div>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight text-ink">Model pricing, measured</h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-soft">
          Per-token list prices next to the number a bill is actually made of: live-measured cost
          per 1,000 requests, per kind of work — hidden reasoning tokens included.
        </p>
        <div className="mt-10 overflow-x-auto border border-[#d9d5cb] bg-[#fbfaf7]">
          <table className="w-full text-left font-mono text-[12.5px]">
            <thead className="text-[11.5px] uppercase tracking-[0.14em] text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-normal">model</th>
                <th className="px-4 py-2.5 font-normal">vendor</th>
                <th className="px-4 py-2.5 text-right font-normal">$ / 1M in</th>
                <th className="px-4 py-2.5 text-right font-normal">$ / 1M out</th>
                <th className="px-4 py-2.5 text-right font-normal">measured $ / 1K requests</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const costs = m.appearances.map((a) => a.costPer1K);
                const lo = Math.min(...costs);
                const hi = Math.max(...costs);
                return (
                  <tr key={m.slug} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2 text-ink">
                      <Link href={`/answers/pricing/${m.slug}`} className="hover:text-accent">{m.label}</Link>
                    </td>
                    <td className="px-4 py-2 text-soft">{m.vendor ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-soft">${m.inputPer1M.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-soft">${m.outputPer1M.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">{lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 font-mono text-[12px] leading-relaxed text-faint">
          only models on a live measured frontier appear · measured ranges span the workloads each
          model earns · <Link href="/research/methodology" className="text-accent underline">method</Link>
        </p>
      </main>
    </SiteShell>
  );
}
