// THE THREE-DIRECTION AUDIT CHECK (spec §3; review addition 3: this runs
// in CI via verify — unmapped decoration is a suite failure).
//
//   1. COMPLETENESS: every FormState leaf ↔ exactly one AUDIT row.
//   2. SOURCE REALITY: every row's accessor executes against the CAPTURED
//      fixtures (the same JSON the design gate reviewed) without throwing.
//   3. THE FENCE: draw.ts imports nothing but FormState + theme
//      (fence.test.ts, alongside).
// Plus: every THEME constant is enumerated in THEME_AUDIT — taste is
// inspectable and bounded — and the provisional amp clamp carries its
// re-derivation note in source (review addition 2).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUDIT, THEME_AUDIT } from './audit.js';
import { deriveFormState } from './form-state.js';
import { THEME } from './theme.js';
import type { HarnessDto, MemoryDto, RunDto } from './dto.js';

const CAPTURED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../docs/design/step-09-captured-data.json', import.meta.url)),
    'utf8',
  ),
) as {
  harnessBefore: HarnessDto;
  harnessAfter: HarnessDto;
  memory: MemoryDto;
  runSnapshots: Array<{ tMs: number; run: RunDto }>;
};

const H = CAPTURED.harnessBefore;
const M = CAPTURED.memory;
const R = CAPTURED.runSnapshots[CAPTURED.runSnapshots.length - 1]!.run;

/** The audit flatten rule: primitives are leaves; ARRAYS are single leaves
 * at the array path; nested objects recurse. */
function leaves(obj: unknown, prefix = ''): string[] {
  if (Array.isArray(obj)) return [prefix];
  if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      leaves(v, prefix === '' ? k : `${prefix}.${k}`),
    );
  }
  return [prefix];
}

describe('audit direction 1 — completeness, both ways', () => {
  const state = deriveFormState(H, M, R, 500);
  const statePaths = new Set(leaves(state));
  const auditPaths = new Set(Object.keys(AUDIT));

  it('every FormState leaf has an audit row (unmapped decoration FAILS)', () => {
    for (const p of statePaths) {
      expect(auditPaths.has(p), `FormState leaf '${p}' has NO audit row — decoration does not ship`).toBe(true);
    }
  });

  it('every audit row names a real FormState leaf (no dead rows)', () => {
    for (const p of auditPaths) {
      expect(statePaths.has(p), `audit row '${p}' maps no FormState leaf`).toBe(true);
    }
  });
});

describe('audit direction 2 — source reality against the captured fixtures', () => {
  it('every accessor executes on the design-gate data and reaches a datum', () => {
    for (const [key, row] of Object.entries(AUDIT)) {
      const value = row.source(H, M, R, 500);
      expect(value, `audit '${key}' accessor returned undefined on the fixtures — its source does not exist`).not.toBeUndefined();
      expect(row.sourcePath.length).toBeGreaterThan(4);
    }
  });

  it('config-only accessors also work with NO run attached (static-config view)', () => {
    for (const [key, row] of Object.entries(AUDIT)) {
      if (row.cadence === 'on-load' || row.cadence === 'on-edit') {
        expect(row.source(H, M, null, null), `config accessor '${key}' needs a run — wrong cadence class`).not.toBeUndefined();
      }
    }
  });
});

describe('the taste surface is enumerated and bounded', () => {
  it('every THEME constant has a THEME_AUDIT entry, and vice versa', () => {
    const themeKeys = new Set(Object.keys(THEME));
    const auditKeys = new Set(Object.keys(THEME_AUDIT));
    for (const k of themeKeys) expect(auditKeys.has(k), `THEME.${k} is unaudited taste`).toBe(true);
    for (const k of auditKeys) expect(themeKeys.has(k), `THEME_AUDIT.${k} audits nothing`).toBe(true);
  });

  it('the pulse-amp clamp carries its re-derivation note IN SOURCE (review addition 2)', () => {
    const src = readFileSync(fileURLToPath(new URL('./theme.js', import.meta.url).href.replace('/dist/', '/src/').replace('.js', '.ts')), 'utf8');
    expect(src).toMatch(/RE-DERIVATION NOTE/);
    expect(src).toMatch(/WORTH_TO_FUEL/);
    expect(src).toMatch(/RETIRE the clamp/);
  });
});
