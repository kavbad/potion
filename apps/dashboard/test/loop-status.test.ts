// The live loop strip's row derivation. These are honesty rules: an
// endpoint that has not answered contributes NO row (absence is never a
// zero), and "off" is printed only when the server actually said off.
import { describe, expect, it } from 'vitest';
import { loopRows } from '@/components/loop-status';

const NOTHING = { learning: null, workloads: null, holdout: null, hasOutcomes: null, hasShadow: null };

describe('loop status — row derivation', () => {
  it('renders nothing at all until something has loaded', () => {
    expect(loopRows(NOTHING)).toEqual([]);
  });

  it('a failed learning fetch contributes no sampling row — not "0 samples"', () => {
    const rows = loopRows({ ...NOTHING, holdout: { enabled: true, rate: 0.05 } });
    expect(rows.map((r) => r.key)).toEqual(['holdout']);
  });

  it('counts samples and kinds of work once sampling is consented', () => {
    const rows = loopRows({
      ...NOTHING,
      learning: { samplingConsent: true, samples: { classification: 12, 'code-gen': 4 }, proposals: [] },
    });
    expect(rows[0]!.detail).toBe('16 samples across 2 kinds of work');
    expect(rows[0]!.needsYou).toBeUndefined();
  });

  it('flags consent-off as needing the human, and says why it matters', () => {
    const rows = loopRows({
      ...NOTHING,
      learning: { samplingConsent: false, samples: {}, proposals: [] },
    });
    expect(rows[0]!.needsYou).toBe(true);
    expect(rows[0]!.detail).toContain('off');
  });

  it('surfaces open bar proposals as waiting on you', () => {
    const rows = loopRows({
      ...NOTHING,
      learning: { samplingConsent: true, samples: {}, proposals: [{ status: 'proposed' }, { status: 'applied' }] },
    });
    expect(rows.find((r) => r.key === 'bars')?.detail).toBe('1 waiting on you');
  });

  it('breaks workloads down by status and asks for a decision only when one is ready', () => {
    const rows = loopRows({
      ...NOTHING,
      workloads: [{ status: 'adopted' }, { status: 'measured' }, { status: 'observed' }, { status: 'observed' }],
    });
    const w = rows.find((r) => r.key === 'workloads')!;
    expect(w.detail).toBe('1 routed · 1 measured, ready to route · 2 still being watched');
    expect(w.needsYou).toBe(true);
  });

  it('does not ask for a decision when every workload is already routed', () => {
    const rows = loopRows({ ...NOTHING, workloads: [{ status: 'adopted' }] });
    expect(rows.find((r) => r.key === 'workloads')?.needsYou).toBe(false);
  });

  it('points a verdict-less org at the docs, and stops asking once outcomes arrive', () => {
    expect(loopRows({ ...NOTHING, hasOutcomes: false })[0]).toMatchObject({ href: '/docs#outcomes', needsYou: true });
    expect(loopRows({ ...NOTHING, hasOutcomes: true })[0]!.needsYou).toBeUndefined();
  });

  it('states the savings basis honestly in both directions', () => {
    expect(loopRows({ ...NOTHING, holdout: { enabled: true, rate: 0.02 } })[0]!.detail).toContain('2.0% of traffic');
    expect(loopRows({ ...NOTHING, holdout: { enabled: true, rate: 0 } })[0]!.detail).toContain('projected');
    expect(loopRows({ ...NOTHING, holdout: { enabled: false, rate: 0.05 } })[0]!.needsYou).toBe(true);
  });

  // The server's field is `enabled`; reading `consent` printed "off" for
  // every org no matter what they had set.
  it('reads the enabled flag the server actually sends', () => {
    const row = loopRows({ ...NOTHING, holdout: { enabled: true, rate: 0.05 } })[0]!;
    expect(row.detail).toContain('on —');
    expect(row.needsYou).toBe(false);
  });

  it('never tells an ineligible org to flip a switch that cannot run', () => {
    const row = loopRows({
      ...NOTHING,
      holdout: { enabled: false, rate: 0.02, eligible: false, why: 'no incumbent designated' },
    })[0]!;
    expect(row.detail).toContain('needs a model to compare against');
    expect(row.href).toBe('/settings/controls');
  });
});
