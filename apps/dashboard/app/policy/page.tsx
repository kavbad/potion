import { PolicyPicker } from '@/components/policy-picker';

export const dynamic = 'force-dynamic';

export default function PolicyPage() {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold tracking-tight">Set a policy</h1>
      <p className="mb-10 mt-2 text-sm leading-relaxed text-soft">
        One knob, three ways to turn it. Potion re-points your key at the right spot on every
        cluster&apos;s frontier — your code never changes.
      </p>
      <PolicyPicker />
    </div>
  );
}
