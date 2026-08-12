// The fixture corpus, run through BOTH validators, with completeness
// meta-tests in every direction (the route-inventory pattern):
//   1. every fixture on disk is classified in expected.ts;
//   2. every expected.ts row has a file on disk;
//   3. every SpecIssueCode is produced by at least one fixture (a rejection
//      path no fixture exercises is untested surface);
//   4. per-fixture assertions are FAILS-FOR-THE-RIGHT-REASON: the expected
//      code, not merely `ok: false`;
//   5. the published JSON Schema agrees with its expected column, and every
//      parse↔ajv divergence carries a stated layer reason.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { EXPECTED } from '../fixtures/expected.js';
import { parseHarnessSpecText } from './parse.js';
import { ALL_SPEC_ISSUE_CODES } from './types.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL('../schema/harness-spec.schema.json', import.meta.url));

function fixtureFilesOnDisk(): string[] {
  const out: string[] = [];
  for (const dir of ['valid', 'invalid', 'adversarial']) {
    for (const f of readdirSync(`${FIXTURES_DIR}/${dir}`)) {
      if (f.endsWith('.json')) out.push(`${dir}/${f}`);
    }
  }
  return out.sort();
}

const ajv = new Ajv2020({ allErrors: true });
const validateShape = ajv.compile(
  JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>,
);

describe('fixture corpus — completeness', () => {
  it('every fixture on disk is classified, and every classification has a file', () => {
    const disk = fixtureFilesOnDisk();
    const expectedKeys = Object.keys(EXPECTED).sort();
    expect(disk, 'unclassified fixture(s) on disk — add them to fixtures/expected.ts').toEqual(
      expectedKeys,
    );
  });

  it('every SpecIssueCode is produced by at least one fixture (no dead reason codes)', () => {
    const produced = new Set(
      Object.values(EXPECTED)
        .map((e) => e.parse)
        .filter((p) => p !== 'valid'),
    );
    const dead = ALL_SPEC_ISSUE_CODES.filter((c) => !produced.has(c));
    expect(dead, 'issue codes no fixture exercises — untested rejection surface').toEqual([]);
  });

  it('every parse↔ajv divergence carries a stated layer reason', () => {
    const unexplained = Object.entries(EXPECTED)
      .filter(([, e]) => {
        const parseValid = e.parse === 'valid';
        const ajvValid = e.ajv === 'valid';
        return parseValid !== ajvValid && e.layer === undefined && e.ajv !== 'unparseable';
      })
      .map(([f]) => f);
    expect(
      unexplained,
      'divergent fixtures with no layer reason — the JSON Schema would silently claim to enforce what it cannot',
    ).toEqual([]);
  });
});

describe('fixture corpus — every fixture, both validators', () => {
  for (const [file, expected] of Object.entries(EXPECTED)) {
    it(`${file} → parse=${expected.parse}, ajv=${expected.ajv}`, () => {
      const text = readFileSync(`${FIXTURES_DIR}/${file}`, 'utf8');

      // ---- the enforcement truth ----
      const result = parseHarnessSpecText(text);
      if (expected.parse === 'valid') {
        expect(result.ok, JSON.stringify(!result.ok ? result.issues : [])).toBe(true);
        if (result.ok) expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Fails for the RIGHT reason.
          expect(
            result.issues.map((i) => i.code),
            `expected issue '${expected.parse}', got ${JSON.stringify(result.issues)}`,
          ).toContain(expected.parse);
        }
      }

      // ---- the published structural contract ----
      if (expected.ajv === 'unparseable') {
        expect(() => JSON.parse(text)).toThrow();
        return;
      }
      const value: unknown = JSON.parse(text);
      expect(
        validateShape(value),
        `ajv disagreed with its expected column; errors: ${JSON.stringify(validateShape.errors)}`,
      ).toBe(expected.ajv === 'valid');
    });
  }
});
