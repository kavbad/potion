// /receipts (S2, brief v4) — the ledger. Self-describing first line, per the
// system rule: every page's first line says what it is.
import { ReceiptsLedger } from '@/components/receipts-ledger';

export const dynamic = 'force-dynamic';

export default function ReceiptsPage() {
  return (
    <div className="max-w-4xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Receipts</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        Every token, accounted for. Each request your key served, what answered it, and what the
        alternative would have cost — read back from the response&rsquo;s own trace, never reconstructed.
      </p>
      <ReceiptsLedger />
    </div>
  );
}
