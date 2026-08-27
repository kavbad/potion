// The methodology page (Answer Engine C1) — the one canonical "how the
// numbers are made" every measured claim links to. Hand-written; the
// citation magnet. Content mirrors what the product actually does — when
// the machinery changes, this page must change in the same commit.
import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteShell } from '@/components/site-header';
import { siteOrigin } from '@/lib/research';

export const metadata: Metadata = {
  title: 'How the numbers are made — measurement methodology · Frontier Notes',
  description:
    'How Potion measures model quality, cost, and latency: held-out suites, deterministic scoring first, calibrated judges where unavoidable, boundary-honest confidence intervals, saturation alarms, and published negatives.',
  alternates: { canonical: '/research/methodology' },
};

function S({ k, title, children }: { k: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <div className="font-mono text-[11.5px] uppercase tracking-[0.13em] text-faint">{k}</div>
      <h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-soft">{children}</div>
    </section>
  );
}

export default function MethodologyPage() {
  const origin = siteOrigin();
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: 'How the numbers are made',
    description: 'The measurement methodology behind every number Potion publishes.',
    author: { '@type': 'Organization', name: 'Potion Research', url: `${origin}/research` },
    publisher: { '@type': 'Organization', name: 'Potion', url: origin },
    url: `${origin}/research/methodology`,
  };
  return (
    <SiteShell current="research">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />
      <main className="mx-auto max-w-3xl px-6 py-14 sm:py-20">
        <nav className="font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
          <Link href="/research" className="hover:text-accent">Frontier Notes</Link> · methodology
        </nav>
        <h1 className="mt-4 text-3xl font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">
          How the numbers are made
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-soft">
          Every number Potion publishes — on the answers pages, in the weekly issues, on a
          customer&apos;s receipts — comes from one measurement discipline. This page is that
          discipline, stated plainly, including where it fails.
        </p>

        <S k="instruments" title="Held-out suites, hardened when they saturate">
          <p>
            Each kind of work has a held-out suite: fixed task items with known correct answers or
            executable checks, authored privately so they cannot be memorized from the public
            internet. Models are measured on the same items under the same scoring. When multiple
            models ace a suite repeatedly, the suite has stopped discriminating — an automatic
            saturation alarm triggers authoring of harder items, because a perfect score on a
            saturated instrument is a statement about the instrument, not the model.
          </p>
        </S>

        <S k="scoring" title="Deterministic first; judges only with calibration receipts">
          <p>
            Wherever objective truth exists, scoring is deterministic: generated code executes
            against tests in a sandbox; extractions match fields against references; classifications
            match labels exactly; tool calls match expected functions and arguments. LLM judges are
            used only where a task is genuinely subjective — and every judge is calibrated against
            tasks with deterministic truth before its scores count. The calibrations are published,
            including the failures: reference-free judging of extractions is measurably blind to
            omissions, so it is not used.
          </p>
        </S>

        <S k="uncertainty" title="Intervals that stay honest at the boundary">
          <p>
            Every quality number carries a sample size and a 95% interval. Intervals use the
            generalized Jeffreys method, which stays honest at the boundary: a model that scores
            42/42 is reported as &ldquo;no failures observed in 42 tasks&rdquo; — a lower bound with
            real width — never as certainty. A champion&apos;s crown is a ≥-bound.
          </p>
        </S>

        <S k="cost" title="Cost measured from real usage, not list price">
          <p>
            Cost per 1,000 requests comes from measured token usage on real provider calls at
            current prices — including hidden reasoning tokens, which make some models far more
            expensive per request than their per-token price suggests. Scoring spend is accounted
            separately so a measurement&apos;s own cost never contaminates a model&apos;s.
          </p>
        </S>

        <S k="freshness" title="Re-measured weekly; drift caught by canaries">
          <p>
            The frontiers behind these pages are re-checked weekly: small fresh canary runs on every
            routed pick, full re-measurement when the market moves, auditions for newly listed
            models. A published page updates when its measurement does, and shows its measurement
            date. A model that silently degrades behind an API is caught by the canary, not by a
            customer.
          </p>
        </S>

        <S k="negatives" title="Negatives published with the same prominence">
          <p>
            When a hypothesis fails, the failure is published: the multi-model mixing program closed
            with five pre-registered negative results, in public. A measurement lab that only
            reports wins is a marketing department.
          </p>
        </S>

        <S k="scope" title="What these numbers are not">
          <p>
            Suite measurements are a prior, not a verdict on your traffic. Production behavior is
            verified per customer: a learning period measures consenting customers&apos; own
            requests, picks are re-verified on their data, and guarantees ride those measurements —
            not these pages. Names that are part of the product are withheld from public pages;
            their numbers are not.
          </p>
        </S>

        <p className="mt-12 font-mono text-[12.5px] text-faint">
          the current answers: <Link href="/answers" className="text-accent underline">/answers</Link>
          {' · '}the weekly issues: <Link href="/research" className="text-accent underline">/research</Link>
          {' · '}the product: <Link href="/home" className="text-accent underline">withpotion.com</Link>
        </p>
      </main>
    </SiteShell>
  );
}
