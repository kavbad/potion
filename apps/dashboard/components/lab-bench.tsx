// THE BENCH v2 (LAB-DESIGN.md, 2026-08-27) — daylight. The first bench was
// deep ink; the operator's verdict was decisive: pages you READ cannot live
// on a dark ground. The Lab is now the same warm paper as the rest of
// Potion. The ONE dark element left is the instrument's viewport
// (lab-form-view), where the organism is the light source — a screen set
// into paper, like every serious instrument. Lab identity lives in the
// specimen mark, the trust line, and the graduation pulse — not in gloom.
//
// Everything here renders DATA — states, counts, dates, tiers. The
// organism's own palette (lab-form THEME) is never borrowed for furniture.

/** Paper-card surface shared by every Lab card (same vocabulary as the
 * research/answers pages — one product, one paper). */
export const CARD = 'border border-[#d9d5cb] bg-[#fbfaf7]';

/** Lab content region: plain daylight, app-shell width. */
export function LabStage({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl">{children}</div>;
}

/** Mono eyebrow label — the same paper eyebrow the rest of the house uses. */
export function BenchLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
      <span className="text-soft">{children}</span>
      {right !== undefined && <span className="text-right">{right}</span>}
    </div>
  );
}

/** The trust-at-a-glance line: grant-state counts, colored by the data. */
export function TrustLine({ trust }: { trust: { autonomous: number; supervised: number; blocked: number } }) {
  const total = trust.autonomous + trust.supervised + trust.blocked;
  if (total === 0) {
    return <span className="font-mono text-[12px] text-faint">newborn — every action asks first</span>;
  }
  return (
    <span className="font-mono text-[12px] text-soft">
      {trust.autonomous > 0 && <span className="text-kept">{trust.autonomous} act alone</span>}
      {trust.autonomous > 0 && (trust.supervised > 0 || trust.blocked > 0) && ' · '}
      {trust.supervised > 0 && <span>{trust.supervised} ask first</span>}
      {trust.supervised > 0 && trust.blocked > 0 && ' · '}
      {trust.blocked > 0 && <span className="text-refuse">{trust.blocked} blocked</span>}
    </span>
  );
}

/** Specimen identity ring: a quiet hash-derived mark (identity, not data —
 * the same role a favicon plays). Hue rotates by hash; nothing else does. */
export function SpecimenMark({ hash, size = 34 }: { hash: string; size?: number }) {
  const hue = parseInt(hash.slice(0, 6), 16) % 360;
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        border: `1.5px solid hsl(${hue} 45% 42%)`,
        background: `radial-gradient(circle at 38% 34%, hsl(${hue} 55% 72% / 0.55), hsl(${hue} 45% 55% / 0.12) 70%)`,
      }}
    />
  );
}
