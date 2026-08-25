// /settings/controls (P1-7; absorbed /policy in the 2026-08-24 surface
// review) — every lever in one place: the policy shape that points your key
// at the frontier, the quality floor, and the spending cap. Two surfaces for
// one knob was the old layout's bug, not a feature.
import { BudgetCard } from '@/components/budget-card';
import { FloorCard } from '@/components/floor-card';
import { FrontierStatus } from '@/components/frontier-status';
import { IncumbentSettings } from '@/components/incumbent-settings';
import { PolicyPicker } from '@/components/policy-picker';
import { SettingsTabs } from '@/components/settings-tabs';

export const dynamic = 'force-dynamic';

export default function ControlsPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Controls</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        The policy decides what your key optimizes for, the quality floor decides how good every
        answer must be, and the spending cap decides how much a month may cost. Everything else
        follows from these three.
      </p>
      <SettingsTabs />
      <PolicyPicker mode="settings" />
      <FloorCard />
      <IncumbentSettings />
      <FrontierStatus />
      <BudgetCard />
    </div>
  );
}
