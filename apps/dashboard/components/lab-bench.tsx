// THE BENCH (LAB-DESIGN.md, 2026-08-26) — the Lab's stage furniture. Deep
// ink inside the light app chrome: the workshop after hours, where the
// organisms are the light source. Everything here renders DATA — states,
// counts, dates, tiers. The organism's own palette (lab-form THEME) is
// never borrowed for furniture.

export const BENCH = {
  ground: '#0b0e14',
  raised: '#10141d',
  line: '#1c2230',
  text: '#c9d2e0',
  muted: '#8b96a8',
  faint: '#5c6678',
  earned: '#57d9a3',
  refusal: '#ff5470',
} as const;

/** Full-bleed dark stage: the Lab pages' content region. */
export function LabStage({ children }: { children: React.ReactNode }) {
  return (
    <div className="-mx-5 -my-6 min-h-[calc(100vh-0px)] px-6 py-10 md:-mx-10 md:-my-10 md:px-10 lg:-mx-14 lg:px-14" style={{ background: BENCH.ground, color: BENCH.text }}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </div>
  );
}

/** Mono bench label — the workshop's equivalent of the paper eyebrow. */
export function BenchLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div
      className="flex items-baseline justify-between border-b pb-2 font-mono text-[11.5px] uppercase tracking-[0.14em]"
      style={{ borderColor: BENCH.line, color: BENCH.faint }}
    >
      <span>{children}</span>
      {right !== undefined && <span>{right}</span>}
    </div>
  );
}

/** The trust-at-a-glance line: grant-state counts, colored by the data. */
export function TrustLine({ trust }: { trust: { autonomous: number; supervised: number; blocked: number } }) {
  const total = trust.autonomous + trust.supervised + trust.blocked;
  if (total === 0) {
    return (
      <span className="font-mono text-[12px]" style={{ color: BENCH.faint }}>
        newborn — every action asks first
      </span>
    );
  }
  return (
    <span className="font-mono text-[12px]" style={{ color: BENCH.muted }}>
      {trust.autonomous > 0 && <span style={{ color: BENCH.earned }}>{trust.autonomous} act alone</span>}
      {trust.autonomous > 0 && (trust.supervised > 0 || trust.blocked > 0) && ' · '}
      {trust.supervised > 0 && <span>{trust.supervised} ask first</span>}
      {trust.supervised > 0 && trust.blocked > 0 && ' · '}
      {trust.blocked > 0 && <span style={{ color: BENCH.refusal }}>{trust.blocked} blocked</span>}
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
        border: `1.5px solid hsl(${hue} 45% 62% / 0.85)`,
        boxShadow: `inset 0 0 ${size / 3}px hsl(${hue} 55% 55% / 0.25)`,
      }}
    />
  );
}
