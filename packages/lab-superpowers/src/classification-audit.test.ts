// Step 12 target T8 — the classification audit's COMPLETENESS meta-test.
//
// The audit itself is an exhibit (audit/step-12-classification.json): one
// row per catalog tool, each naming the vendor operation the reviewer
// believes the tool maps to and rating its own confidence. The exhibit is
// only worth something if it cannot quietly shrink, so this file pins it
// both ways against the live catalog, and pins that every reclassification
// the audit CLAIMS to have made is actually present in the catalog.
//
// It also states the audit's own limit as an assertion rather than a
// footnote: not one of these verdicts checked a name against a live vendor
// server, because every package is fixture-authored.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOG } from './catalog.js';

interface AuditRow {
  pkg: string;
  tool: string;
  verdict: 'correct' | 'reclassified' | 'corrected';
  confidence: 'verified' | 'documented' | 'unverifiable';
  vendorOperation: string;
}
const AUDIT = JSON.parse(
  readFileSync(fileURLToPath(new URL('../audit/step-12-classification.json', import.meta.url)), 'utf8'),
) as { rows: AuditRow[]; method: string; failClosedRule: string };

const key = (p: string, t: string): string => `${p}.${t}`;

describe('T8 audit exhibit — complete, both directions', () => {
  it('every catalog tool has exactly one verdict, and every verdict names a real tool', () => {
    const catalogKeys = CATALOG.flatMap((p) => p.tools.map((t) => key(p.id, t.name))).sort();
    const auditKeys = AUDIT.rows.map((r) => key(r.pkg, r.tool)).sort();
    expect(auditKeys).toEqual(catalogKeys);
    expect(new Set(auditKeys).size).toBe(auditKeys.length); // no duplicate rows
    // 116 vendor-mapped tools at the T8 audit + 2 in-process web builtins
    // (P1, 2026-08-28) + 1 code builtin (X1, same day) + 3 browser builtins
    // (X6, 2026-08-30) — builtin rows cite the runtime implementation, not
    // a vendor endpoint, because there is none.
    expect(catalogKeys.length).toBe(122);
  });

  it('every row cites a vendor operation — no blank verdicts padding the count', () => {
    for (const r of AUDIT.rows) {
      expect(r.vendorOperation.length, `${key(r.pkg, r.tool)}: empty citation`).toBeGreaterThan(10);
    }
  });

  it('the fail-closed rule was APPLIED: every reclassified tool is an act in the catalog now', () => {
    const reclassified = AUDIT.rows.filter((r) => r.verdict === 'reclassified');
    // Non-vacuous: the audit is only worth running if it changed something.
    expect(reclassified.length).toBeGreaterThanOrEqual(5);
    for (const r of reclassified) {
      const tool = CATALOG.find((p) => p.id === r.pkg)!.tools.find((t) => t.name === r.tool)!;
      expect(tool.action, `${key(r.pkg, r.tool)}: audit says reclassified, catalog says ${tool.action}`).toBe('act');
    }
  });

  it('every reclassified tool sits in a package whose version MOVED off 1.0.0', () => {
    // The classification gate demands version + content hash together; this
    // asserts the audit's own edits obeyed the gate rather than regenerating
    // around it.
    for (const r of AUDIT.rows.filter((x) => x.verdict !== 'correct')) {
      const pkg = CATALOG.find((p) => p.id === r.pkg)!;
      expect(pkg.version, `${r.pkg}: changed by the audit but still at 1.0.0`).not.toBe('1.0.0');
    }
  });

  it('the audit publishes its own bound: no verdict checked a name against a live server', () => {
    expect(AUDIT.method).toContain('No vendor API was called');
    // …and that bound is TRUE of the catalog as it stands: nothing claims
    // live-proven, so no row could have been checked against a live wire.
    expect(CATALOG.every((p) => p.proof === 'fixture-authored')).toBe(true);
  });

  it('unverifiable verdicts are named, not hidden in an average', () => {
    const unverifiable = AUDIT.rows.filter((r) => r.confidence === 'unverifiable');
    expect(unverifiable.length).toBeGreaterThan(0);
    // Each one either became an act, or says in writing why it stayed a read.
    for (const r of unverifiable) {
      const tool = CATALOG.find((p) => p.id === r.pkg)!.tools.find((t) => t.name === r.tool)!;
      if (tool.action === 'read') {
        expect(r.vendorOperation, `${key(r.pkg, r.tool)}: unverifiable read with no stated reason`).toMatch(
          /read-leaning|stays read/i,
        );
      }
    }
  });
});
