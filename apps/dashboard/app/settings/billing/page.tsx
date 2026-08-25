// /settings/billing (R0) — what this month costs, the card on file, history.
// The month's invoice download moved here from /usage (2026-08-24 surface
// review): one page answers every money question.
import { BillingCard } from '@/components/billing-card';
import { SettingsTabs } from '@/components/settings-tabs';

export const dynamic = 'force-dynamic';

export default function BillingPage() {
  const period = new Date().toISOString().slice(0, 7);
  return (
    <div className="max-w-3xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Billing</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        Aligned by construction: model costs pass through at cost, and Potion earns a share of
        the savings your receipts verify. Save nothing, and you pay nothing above cost.
      </p>
      <SettingsTabs />
      <BillingCard />
      <p className="mt-6 text-sm text-soft">
        <a
          href={`/api/usage/invoice?period=${period}&format=html`}
          className="text-accent underline"
        >
          Download this month&rsquo;s invoice ({period})
        </a>
      </p>
    </div>
  );
}
