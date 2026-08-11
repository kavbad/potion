// F11: the badge must obey the GATE, never re-derive certification from the
// row's status. The page previously tested `status === 'certified'` itself,
// so it rendered CERTIFIED while the guarantee report withheld the retention
// headline for the same cluster in the same second.
import { describe, expect, it } from 'vitest';
import { certificationBadge } from '../lib/cert-badge';

const row = (over: Partial<Parameters<typeof certificationBadge>[0]> = {}) => ({
  status: 'certified' as const,
  active: true,
  refused: false,
  ...over,
});

describe('certificationBadge', () => {
  it('CERTIFIED only when the gate says this row vouches right now', () => {
    expect(certificationBadge(row()).label).toBe('CERTIFIED');
  });

  it('THE DEFECT: a certified ROW the gate no longer honors reads STALE, never CERTIFIED', () => {
    // Same row status as above — only the gate's answer differs. Pre-fix this
    // returned CERTIFIED, because the badge never consulted the gate.
    const b = certificationBadge(row({ active: false }));
    expect(b.label).toBe('STALE — NOT CERTIFIED');
    expect(b.label).not.toContain('CERTIFIED —'); // not a certified-prefixed label
    expect(b.cls).toContain('warn'); // attention, not the accent "good" colour
  });

  it('distinguishes STALE from FAILED and REFUSED — the remedies differ', () => {
    expect(certificationBadge(row({ status: 'failed', active: false })).label).toBe(
      'FAILED — NOT CERTIFIED',
    );
    expect(
      certificationBadge(row({ status: 'failed', active: false, refused: true })).label,
    ).toBe('REFUSED — NOT MEASURED');
    expect(certificationBadge(row({ status: 'superseded', active: false })).label).toBe(
      'SUPERSEDED — NOT CERTIFIED',
    );
    expect(certificationBadge(row({ status: 'pending', active: false })).label).toBe(
      'PENDING — NOT CERTIFIED',
    );
  });

  it('every non-active state says NOT CERTIFIED or NOT MEASURED — house vocabulary', () => {
    for (const s of ['certified', 'failed', 'superseded', 'pending'] as const) {
      for (const refused of [true, false]) {
        const b = certificationBadge(row({ status: s, active: false, refused }));
        expect(b.label).toMatch(/NOT (CERTIFIED|MEASURED)$/);
        expect(b.cls).not.toContain('accent'); // the "good" colour is gate-only
      }
    }
  });
});
