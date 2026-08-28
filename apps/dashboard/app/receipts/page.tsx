// /receipts (S2, brief v4) — the ledger. Self-describing first line, per the
// system rule: every page's first line says what it is.
import { ReceiptsLedger } from '@/components/receipts-ledger';
import { TryRequest } from '@/components/try-request';

export const dynamic = 'force-dynamic';

export default function ReceiptsPage() {
  return (
    <div className="max-w-4xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Receipts</h1>
      <p className="mb-6 mt-2 text-sm leading-relaxed text-soft">
        Every token, accounted for. Each request your key served, what answered it, and what the
        alternative would have cost — read back from the response&rsquo;s own trace, never reconstructed.
      </p>
      {/* Try folds in here (2026-08-27 redesign): the result lands on this
          ledger anyway, so the test affordance lives where the proof does. */}
      <details className="mb-8 border border-[#d9d5cb] bg-[#fbfaf7]">
        <summary className="cursor-pointer px-5 py-3 font-mono text-[12px] uppercase tracking-[0.13em] text-soft hover:text-accent">
          send a test request — watch its receipt land below
        </summary>
        <div className="border-t border-[#d9d5cb] px-5 py-4">
          <TryRequest />
        </div>
      </details>
      <ReceiptsLedger />
    </div>
  );
}
