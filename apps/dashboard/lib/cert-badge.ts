// Certification badge vocabulary (F11).
//
// This function READS the server's gate-derived `active` flag; it must never
// re-derive certification from `status` alone. That re-derivation was the
// defect: the page had its own `status === 'certified'` test, so the badge
// said CERTIFIED while the guarantee report withheld the retention headline
// for the same cluster in the same second — a certification badge shown to a
// customer that our own gate refuses.
//
// STALE is the state the surface previously could not express: a real,
// passing measurement that no longer vouches for anything because the suite
// was re-derived or flipped generation underneath it. It is distinct from
// FAILED (the incumbent could not reproduce its own baseline) because the
// remedy differs — re-certify vs fix the suite — and from REFUSED (no
// measurement happened at all).
export interface CertificationBadgeInput {
  status: 'pending' | 'certified' | 'failed' | 'superseded';
  /** The GATE's answer: is this row what vouches for its cluster right now? */
  active: boolean;
  refused: boolean;
}

export interface CertificationBadge {
  label: string;
  cls: string;
}

const ACCENT = 'bg-accent/15 text-accent';
const WARN = 'bg-warn/15 text-warn';
const INERT = 'bg-line text-faint';

export function certificationBadge(c: CertificationBadgeInput): CertificationBadge {
  if (c.active) return { label: 'CERTIFIED', cls: ACCENT };
  // A passing measurement the gate no longer honors.
  if (c.status === 'certified') return { label: 'STALE — NOT CERTIFIED', cls: WARN };
  if (c.status === 'superseded') return { label: 'SUPERSEDED — NOT CERTIFIED', cls: INERT };
  if (c.refused) return { label: 'REFUSED — NOT MEASURED', cls: INERT };
  if (c.status === 'pending') return { label: 'PENDING — NOT CERTIFIED', cls: WARN };
  return { label: 'FAILED — NOT CERTIFIED', cls: WARN };
}
