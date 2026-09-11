// The author page (F3, docs/RESEARCH-FLEET.md): a research agent's public
// identity, with every countable claim derived from the published record —
// publications from the issues themselves, verification and run ids from
// each issue's writer block, corrections from the corpus. The identity
// copy is the registry's; the numbers are never hand-written.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteShell } from '@/components/site-header';
import { correctionsForByline, listIssues, RESEARCH_TITLE, verificationClaim } from '@/lib/research';
import { getResearchAuthor } from '@/lib/research-authors';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { name } = await params;
  const a = getResearchAuthor(name);
  if (!a) return { title: `Not found · ${RESEARCH_TITLE}` };
  return {
    title: `${a.name} — ${a.role} · ${RESEARCH_TITLE}`,
    description: a.mission,
    alternates: { canonical: `/research/authors/${a.slug}` },
  };
}

export default async function AuthorPage({ params }: Params) {
  const { name } = await params;
  const a = getResearchAuthor(name);
  if (!a) notFound();
  const issues = listIssues().filter((i) => i.byline.trim().toLowerCase() === a.name.toLowerCase());
  const latestWriter = issues.find((i) => i.writer?.runId)?.writer;
  const generation = latestWriter?.model?.startsWith('delta:') ? latestWriter.model.slice('delta:'.length) : null;
  const verifiedCount = issues.filter((i) => i.writer?.verifiedBy).length;
  const corrections = correctionsForByline(a.name);

  return (
    <SiteShell current="research">
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <header>
          <div className="border-t-2 border-ink" />
          <div className="mt-[3px] border-t border-ink" />
          <nav className="mt-4 flex flex-wrap items-baseline justify-between gap-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
            <Link href="/research" className="text-ink hover:text-accent">{RESEARCH_TITLE}</Link>
            <span>author</span>
          </nav>
        </header>

        <h1 className="mt-6 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em] text-ink sm:text-[2.6rem]">{a.name}</h1>
        <p className="mt-1 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">{a.role}</p>

        <p className="mt-6 text-[17px] leading-relaxed text-ink">{a.mission}</p>

        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-[12.5px] sm:grid-cols-3">
          <div>
            <dt className="uppercase tracking-[0.13em] text-faint">Active since</dt>
            <dd className="mt-0.5 text-ink">{a.activeSince}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-[0.13em] text-faint">Publications</dt>
            <dd className="mt-0.5 text-ink">{issues.length} ({verifiedCount} independently verified)</dd>
          </div>
          {generation && (
            <div>
              <dt className="uppercase tracking-[0.13em] text-faint">Current generation</dt>
              <dd className="mt-0.5 text-ink">{generation}…</dd>
            </div>
          )}
        </dl>

        <section className="mt-10">
          <h2 className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">Research areas</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-soft">{a.areas.join(' · ')}</p>
        </section>

        <section className="mt-10">
          <h2 className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">Work</h2>
          {issues.length === 0 && <p className="mt-2 text-[15px] text-soft">No publications yet.</p>}
          <ul className="mt-3 space-y-4">
            {issues.map((i) => (
              <li key={i.slug} className="border-b border-line pb-4">
                <Link href={`/research/${i.slug}`} className="text-[16px] font-medium text-ink hover:text-accent">{i.title}</Link>
                <div className="mt-1 font-mono text-[11.5px] text-faint">
                  {i.week} · {i.publishedAt.slice(0, 10)}
                  {i.writer?.runId && <> · written in <span className="text-ink">{i.writer.runId}</span></>}
                  {i.writer?.verifiedBy && <> · verified in <span className="text-ink">{i.writer.verifiedBy.runId}</span></>}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10">
          <h2 className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">
            Corrections{corrections.length > 0 && <> · {corrections.length}</>}
          </h2>
          {corrections.length === 0 ? (
            <p className="mt-2 text-[15px] leading-relaxed text-soft">
              No corrections on record. Every correction associated with {a.name} will be listed here, permanently.
            </p>
          ) : (
            <>
              <p className="mt-2 text-[15px] leading-relaxed text-soft">
                Every correction associated with {a.name} is listed here, permanently. A corrected issue keeps its
                original address and carries the correction in its own text — nothing is quietly rewritten.
              </p>
              <ul className="mt-4 space-y-5">
                {corrections.map((c) => (
                  <li key={`${c.slug}-${c.at}`} className="border-l-2 border-[#b8b3a6] pl-4">
                    <div className="font-mono text-[11.5px] text-faint">
                      {c.at.slice(0, 10)} ·{' '}
                      <Link href={`/research/${c.slug}`} className="text-ink hover:text-accent">{c.title}</Link>
                    </div>
                    <p className="mt-2 text-[15px] leading-relaxed text-soft">
                      <span className="text-faint line-through">{c.was}</span>
                    </p>
                    <p className="mt-1 text-[15px] leading-relaxed text-ink">{c.now}</p>
                    {c.why && <p className="mt-1.5 text-[14px] leading-relaxed text-soft">{c.why}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="mt-10 border border-dashed border-[#b8b3a6] bg-[#fbfaf7] px-5 py-4">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">Built with Potion</div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
            {a.name} is a persistent worker built and operated on Potion&apos;s own agent platform. Every issue is drafted in a recorded run and published
            through the same permission gateway every Potion worker answers to. {verificationClaim(issues.length, verifiedCount)} The run ids above are
            those records.
          </p>
        </section>
      </main>
    </SiteShell>
  );
}
