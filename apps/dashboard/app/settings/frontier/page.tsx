// /settings/frontier (R7) — version control over what serves you, and the
// changelog of what moved. The answer to "don't change under me without
// telling me", which procurement asks before it asks about savings.
import { FrontierPins } from '@/components/frontier-pins';
import { SettingsTabs } from '@/components/settings-tabs';

export const dynamic = 'force-dynamic';

export default function FrontierSettingsPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">Frontier &amp; versions</h1>
      <p className="mb-8 mt-2 text-sm leading-relaxed text-soft">
        Every routing decision comes from a measured frontier with a version number. Here you can
        see which version serves you, freeze it, and read what changed when it moves.
      </p>
      <SettingsTabs />
      <FrontierPins />
    </div>
  );
}
