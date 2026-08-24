// /settings/controls (P1-7) — the two levers the product is about, as a
// first-class surface: the quality floor and the spending cap. Both cards
// already speak the real APIs (PUT /api/floor, GET/PUT /api/budgets).
import { BudgetCard } from '@/components/budget-card';
import { FloorCard } from '@/components/floor-card';
import { FrontierStatus } from '@/components/frontier-status';
import { SettingsTabs } from '@/components/settings-tabs';

export const dynamic = 'force-dynamic';

export default function ControlsPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Floor &amp; cap</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        The quality floor decides how good every answer must be; the spending cap decides how much a
        month may cost. Everything else follows from these two.
      </p>
      <SettingsTabs />
      <FloorCard />
      <FrontierStatus />
      <BudgetCard />
    </div>
  );
}
