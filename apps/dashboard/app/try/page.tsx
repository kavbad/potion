import { TryRequest } from '@/components/try-request';

export const dynamic = 'force-dynamic';

export default function TryPage() {
  return (
    <div className="max-w-3xl">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-faint">Try a request</div>
      <h1 className="mt-3 text-[2rem] font-medium leading-[1.12] tracking-[-0.02em] text-ink">
        Send anything. See what Potion chose, and why.
      </h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-soft">
        This goes through the same routing your key gets: the kind of work is detected, the cheapest
        measured model above your quality floor answers, and the receipt comes back with it.
      </p>
      <div className="mt-8">
        <TryRequest />
      </div>
    </div>
  );
}
