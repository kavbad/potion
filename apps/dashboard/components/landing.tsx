// THE LANDING, v8 — one idea, said plainly, shown once.
//
// The brief (operator, 2026-08-22): redesign as if Steve Jobs, Paul Graham
// and a world-class designer did it together. Read that as three rules:
//   Jobs    — one message per screen; the product is the hero; remove
//             everything that is not load-bearing; the details are the design.
//   Graham  — say the true, specific thing in the words you would use out
//             loud; no marketing voice; explain, do not persuade.
//   Designer— one type scale, one accent, rhythm by whitespace and one dark
//             band, nothing decorative.
//
// Seven beats, each a single screen or less: the claim · the receipt · how
// it works · the proof · the honest part · one line of code · the research
// · the close. Gone: the gateway comparison table, the mixtures band, the
// frontier explorer, the day-one promise wall, the instrument tape, the
// scroll rail. Each was true; none was necessary.
//
// Invariants kept: withheld names never enter the DOM (masked in data); no
// supplier named as a competitor; every number is a committed measurement.
import Link from 'next/link';
import { ReceiptReel } from '@/components/landing/receipt-reel';
import { listIssues } from '@/lib/research';

const ROWS = [
  { model: 'or-grok-4.6', q: 1.0, cost: 6.2568, pick: false },
  { model: 'or-gemini-flash', q: 0.9961, cost: 0.5506, pick: false },
  { model: 'or-gpt-mini', q: 0.99, cost: 0.2509, pick: false },
  { model: 'or-deepseek', q: 0.98, cost: 0.1904, pick: false },
  { model: 'or-████████', q: 0.9785, cost: 0.0231, pick: true },
] as const;
const MAX_COST = 6.2568;

function Section({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`mx-auto max-w-3xl px-6 py-24 sm:py-32 ${className}`}>{children}</section>;
}

function Kicker({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">{children}</div>;
}

export function Landing() {
  const latest = listIssues()[0] ?? null;
  return (
    <div>
      {/* 1 · the claim */}
      <section className="mx-auto max-w-4xl px-6 pb-16 pt-24 text-center sm:pt-32">
        <h1 className="text-[3.4rem] font-semibold leading-[1.0] tracking-[-0.035em] text-ink sm:text-[4.75rem] lg:text-[6rem]">
          Cut your AI bill
          <br />
          <span className="relative inline-block">
            in half.
            <span aria-hidden className="absolute bottom-[-0.06em] left-[-0.02em] right-[0.06em] flex items-end">
              <span className="h-[3px] flex-1 bg-accent/80" />
              <span className="h-[0.28em] w-[3px] bg-accent/80" />
            </span>
          </span>
        </h1>
        <p className="mx-auto mt-8 max-w-2xl text-[1.25rem] leading-relaxed text-soft sm:text-[1.45rem]">
          Potion tests AI models on real work, then sends each request to the cheapest one that
          scored good enough. Same quality. About half the bill.
        </p>
        <div className="mt-9 flex items-center justify-center gap-3">
          <Link
            href="/login"
            className="rounded-md bg-ink px-6 py-3 text-[15px] font-medium text-white hover:opacity-90 active:translate-y-px"
          >
            Get an API key
          </Link>
          <Link href="/research" className="px-3 py-3 text-[15px] text-soft hover:text-ink">
            Read the research →
          </Link>
        </div>
      </section>

      {/* 2 · the receipt — the product in its smallest honest form */}
      <section className="px-6 pb-24 sm:pb-32">
        <ReceiptReel />
        <p className="mx-auto mt-5 max-w-2xl text-center text-[14px] text-faint">
          Six real requests, six real decisions. The receipt comes back with every answer.
        </p>
      </section>

      {/* 3 · how it works */}
      <Section className="border-t border-line">
        <Kicker>How it works</Kicker>
        <h2 className="mt-4 text-[2rem] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">
          Three things, in order.
        </h2>
        <ol className="mt-10 space-y-8">
          {[
            ['We test.', 'Every model sits the same exam for each kind of work: sorting text, pulling out fields, writing code, answering from documents. Code is marked by running it. Each score comes with a margin of error.'],
            ['We keep the short list.', 'For each kind of work, the models that are the best deal at their level of quality. Nothing on the list is beaten by something both better and cheaper. New models are tested the week they appear and join only if they earn it.'],
            ['We route.', 'You set one rule, for example "cheapest that scores at least 0.95". Potion reads each request, works out what kind of work it is, and sends it to the cheapest model on the list that passes. When only the expensive model passes, it gets the expensive model.'],
          ].map(([h, p], n) => (
            <li key={h} className="grid grid-cols-[2.5rem_1fr] gap-4">
              <div className="font-mono text-[13px] text-accent">0{n + 1}</div>
              <div>
                <div className="text-[1.125rem] font-medium text-ink">{h}</div>
                <p className="mt-1.5 text-[1.0625rem] leading-relaxed text-soft">{p}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* 4 · the proof — one dark band, one table */}
      <section className="bg-[#1c1917] text-white">
        <div className="mx-auto max-w-3xl px-6 py-24 sm:py-32">
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#99f6e4]">The proof</div>
          <h2 className="mt-4 text-[2rem] font-semibold leading-[1.12] tracking-tight sm:text-[2.5rem]">
            Five models wrote the same code. Scored by running it.
          </h2>
          <p className="mt-5 text-[1.0625rem] leading-relaxed text-white/75">
            Thirty tasks the models had never seen. The quality difference across this table is
            two points in a hundred. The price difference is two hundred and seventy fold.
          </p>
          <div className="mt-10 space-y-4">
            {ROWS.map((r) => (
              <div key={r.model}>
                <div className="flex items-baseline justify-between font-mono text-[12px]">
                  <span className={r.pick ? 'text-[#5eead4]' : 'text-white'}>{r.model}</span>
                  <span className="text-white/60">
                    scores {r.q.toFixed(2)} · ${r.cost.toFixed(2)} per 1,000
                  </span>
                </div>
                <div className="mt-1.5 h-2.5 overflow-hidden rounded-sm bg-white/10">
                  <div className={`h-full rounded-sm ${r.pick ? 'bg-[#2dd4bf]' : 'bg-white/40'}`} style={{ width: `${Math.max(1, (r.cost / MAX_COST) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-[15px] leading-relaxed text-white/75">
            The bottom row is the one Potion sends code to: 99% of the top row&apos;s quality at
            1/270th of the price. Which model it is, is the product. Bars are cost per thousand
            requests; measured 2026-08-20.
          </p>
        </div>
      </section>

      {/* 5 · the honest part */}
      <Section>
        <Kicker>The honest part</Kicker>
        <h2 className="mt-4 text-[2rem] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">
          Sometimes the expensive model is the right one.
        </h2>
        <p className="mt-5 text-[1.0625rem] leading-relaxed text-soft">
          For writing with some flair, nothing cheaper scored good enough this month, so Potion pays
          full price for that work and the receipt says so. Routing is not a discount bin. It is a
          measurement, applied to every request, that spends where quality requires it and nowhere
          else.
        </p>
        <p className="mt-4 text-[1.0625rem] leading-relaxed text-soft">
          And when two models are too close to tell apart, Potion says they are tied and lets your
          rule choose, rather than pretending the measurement is sharper than it is.
        </p>
      </Section>

      {/* 6 · one line of code */}
      <Section className="border-t border-line">
        <Kicker>Using it</Kicker>
        <h2 className="mt-4 text-[2rem] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">
          One line changes.
        </h2>
        <p className="mt-5 text-[1.0625rem] leading-relaxed text-soft">
          Potion speaks the OpenAI chat protocol. Point your existing client at it and keep
          everything else: the request, the response, streaming, tool calls.
        </p>
        <pre className="mt-8 overflow-x-auto rounded-xl border border-line bg-panel px-5 py-4 font-mono text-[13px] leading-relaxed text-ink">
{`const client = new OpenAI({
  baseURL: 'https://api.withpotion.com/v1',  // ← this line
  apiKey: process.env.POTION_API_KEY,
});`}
        </pre>
        <p className="mt-4 text-[14px] text-faint">
          Full details in the <Link href="/docs" className="text-accent underline">docs</Link>.
        </p>
      </Section>

      {/* 7 · the research */}
      <Section className="border-t border-line">
        <Kicker>Every Monday</Kicker>
        <h2 className="mt-4 text-[2rem] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[2.5rem]">
          We publish what we measure.
        </h2>
        <p className="mt-5 text-[1.0625rem] leading-relaxed text-soft">
          Each week every model on the short list is re-checked, newly released models are tested,
          and combinations of cheaper models are tried against the best single one. The results go
          out as Frontier Notes, written so anyone can read them.
        </p>
        {latest && (
          <Link href={`/research/${latest.slug}`} className="mt-8 block rounded-xl border border-line bg-panel px-5 py-4 hover:border-accent/50">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Latest · {latest.week}</div>
            <div className="mt-1.5 text-[1.0625rem] font-medium leading-snug text-ink">{latest.title}</div>
          </Link>
        )}
      </Section>

      {/* 8 · the close */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-3xl px-6 py-24 text-center sm:py-32">
          <h2 className="text-[2.5rem] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[3.5rem]">
            Keep the quality.
            <br />
            Stop paying for the rest.
          </h2>
          <div className="mt-9 flex items-center justify-center gap-3">
            <Link href="/login" className="rounded-md bg-ink px-6 py-3 text-[15px] font-medium text-white hover:opacity-90 active:translate-y-px">
              Get an API key
            </Link>
            <Link href="/docs" className="px-3 py-3 text-[15px] text-soft hover:text-ink">
              Read the docs →
            </Link>
          </div>
          <p className="mt-8 text-[13px] text-faint">
            Usage-based. No minimum. Your first key takes about a minute.
          </p>
        </div>
      </section>
    </div>
  );
}
