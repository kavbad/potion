// Step 12, addition 1 — THE TARGET REGISTER'S META-TEST.
//
// The adversarial pass is judged by what it catches, and the easiest way to
// look thorough is to let targets quietly disappear. So the register is a
// committed artifact and this test is the thing that will not let it shrink:
// every §2 row must be present, every row must close with a TYPED
// disposition from a closed vocabulary, and each disposition must carry the
// evidence its own claim requires. A row cannot close by silence, by prose,
// or by deletion.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Disposition =
  | 'fixed-and-pinned'
  | 'pinned-as-fact'
  | 'owned-and-deferred'
  | 'inconclusive-fail-closed';

interface Row {
  id: string;
  title: string;
  disposition: Disposition;
  reason: string;
  evidence?: string;
  owner?: string;
  failClosedAction?: string;
}

const REGISTER = JSON.parse(
  readFileSync(fileURLToPath(new URL('../artifacts/step-12-targets.json', import.meta.url)), 'utf8'),
) as { rows: Row[]; dispositions: Record<string, string>; rule: string };

/** The §2 table, transcribed. If the spec grows a target, this list grows
 * with it and the register must follow — never the other way round. */
const SPEC_TARGETS = Array.from({ length: 17 }, (_, i) => `T${i + 1}`);

const VOCABULARY: Disposition[] = [
  'fixed-and-pinned',
  'pinned-as-fact',
  'owned-and-deferred',
  'inconclusive-fail-closed',
];

describe('Step 12 target register — no row closes untyped, no row disappears', () => {
  it('every §2 target has exactly one row, and no row invents a target', () => {
    const ids = REGISTER.rows.map((r) => r.id);
    expect(ids.slice().sort()).toEqual(SPEC_TARGETS.slice().sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every disposition comes from the closed vocabulary — an untyped close fails here', () => {
    for (const r of REGISTER.rows) {
      expect(VOCABULARY, `${r.id}: '${r.disposition}' is not a disposition`).toContain(r.disposition);
      expect(REGISTER.dispositions[r.disposition], `${r.id}: vocabulary entry missing`).toBeTruthy();
    }
    // The vocabulary itself is closed: exactly the four types, no additions
    // slipped in to make an awkward row easier to close.
    expect(Object.keys(REGISTER.dispositions).sort()).toEqual(VOCABULARY.slice().sort());
  });

  it('every row states a real reason — not a word, not a shrug', () => {
    for (const r of REGISTER.rows) {
      expect(r.title.length, `${r.id}: no title`).toBeGreaterThan(20);
      expect(r.reason.length, `${r.id}: reason too thin to be a finding-grade answer`).toBeGreaterThan(120);
    }
  });

  it('each disposition carries the evidence its own claim requires', () => {
    for (const r of REGISTER.rows) {
      if (r.disposition === 'fixed-and-pinned') {
        // A fix claim needs a test. Nothing else counts.
        expect(r.evidence ?? '', `${r.id}: fixed-and-pinned with no test cited`).toMatch(/\.test\.ts/);
      }
      if (r.disposition === 'pinned-as-fact') {
        expect(r.evidence ?? '', `${r.id}: pinned-as-fact with nothing pinned`).not.toBe('');
      }
      if (r.disposition === 'owned-and-deferred') {
        // The toolPolicy precedent: a named owner, never a vague later.
        expect(r.owner ?? '', `${r.id}: deferred with no owner`).not.toBe('');
        expect(r.owner!.length).toBeGreaterThan(15);
      }
      if (r.disposition === 'inconclusive-fail-closed') {
        // Inconclusive is only honest if something actually failed closed.
        expect(r.failClosedAction ?? '', `${r.id}: inconclusive with no fail-closed action taken`).not.toBe('');
        expect(r.failClosedAction!.length).toBeGreaterThan(40);
      }
    }
  });

  it('the register is non-vacuous: the pass both FIXED things and DEFERRED things', () => {
    const by = (d: Disposition): number => REGISTER.rows.filter((r) => r.disposition === d).length;
    // A pass that fixed nothing did not look hard; a pass that deferred
    // nothing is not being honest about what a $0 internal review reaches.
    expect(by('fixed-and-pinned')).toBeGreaterThanOrEqual(2);
    expect(by('owned-and-deferred')).toBeGreaterThanOrEqual(2);
    expect(by('pinned-as-fact')).toBeGreaterThanOrEqual(2);
  });

  it('the three targets the operator named explicitly are all closed with evidence', () => {
    for (const id of ['T5', 'T6', 'T8']) {
      const row = REGISTER.rows.find((r) => r.id === id)!;
      expect(row.disposition).not.toBe('owned-and-deferred'); // not punted
      expect(row.evidence ?? '').not.toBe('');
    }
  });
});
