// /settings/billing (R0) — what this month costs, the card on file, history.
import { BillingCard } from '@/components/billing-card';
import { SettingsTabs } from '@/components/settings-tabs';

export const dynamic = 'force-dynamic';

export default function BillingPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Billing</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        Usage-based: you pay for the requests Potion serves, at the prices on your receipts.
      </p>
      <SettingsTabs />
      <BillingCard />
    </div>
  );
}
