// THE ISOLATION-FIXTURE GATE (G2.4 carryover, made structural).
//
// The rule: a cross-tenant / isolation test uses TWO DISTINCT NON-DEFAULT
// orgs; DEFAULT_ORG_ID is never the probed subject. Before this test the rule
// was a convention honoured by exactly one file — and the assumption it bans
// is precisely what hid tenancy defect D1 from the entire prior suite (a
// bearer-only resolver falling back to the demo org looks correct when the
// org under test IS the demo org).
//
// Enforcement follows the mock-eligibility.test.ts precedent: enumerate the
// files, detect the pattern, require the shared fixture or a JUSTIFIED
// exemption. Two rules, deliberately narrow — there are ~230 DEFAULT_ORG_ID
// references across the test tree and most are legitimate (single-org suites
// that simply need *an* org). A blanket ban would produce an exemption map
// larger than the thing it protects.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Test files in scope: the server suite and the db package's own tests. */
function testFiles(): string[] {
  const roots = [path.join(REPO_ROOT, 'apps/server/test'), path.join(REPO_ROOT, 'packages/db/src')];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // This file is the ENFORCER, not a subject: its own body necessarily
      // names DEFAULT_ORG_ID (in the patterns it bans and in the assertion
      // that the fixture rejects it), so scanning itself is a false positive.
      else if (entry.name.endsWith('.test.ts') && entry.name !== 'isolation-fixture.test.ts') {
        out.push(full);
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

const rel = (f: string): string => path.relative(REPO_ROOT, f);

// ---------------------------------------------------------------------------
// R1 — no test may BIND an org-subject constant to the default org.
// No exemptions: this is the exact shape that hid D1, and it has a one-line
// fix (import ORG_A/ORG_B from the fixture).
// ---------------------------------------------------------------------------

const SUBJECT_BIND_RE = /const\s+[A-Z0-9_]*ORG[A-Z0-9_]*\s*(?::\s*string\s*)?=\s*DEFAULT_ORG_ID/;
/** A second org constant ⇒ the suite is MULTI-TENANT by construction, which is
 * exactly the scope of the rule ("cross-tenant tests use two distinct
 * non-default orgs"). A single-org suite that happens to test with the demo
 * org makes no isolation claim and is out of scope — banning it would produce
 * churn without protecting anything. */
const SECOND_ORG_RE = /const\s+[A-Z0-9_]*ORG[A-Z0-9_]*\s*(?::\s*string\s*)?=\s*['"]/;

describe('R1: no isolation subject is bound to the default org', () => {
  it('no MULTI-ORG test file binds an ORG_* constant to DEFAULT_ORG_ID', () => {
    const offenders = testFiles()
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return SUBJECT_BIND_RE.test(src) && SECOND_ORG_RE.test(src);
      })
      .map(rel);
    expect(
      offenders,
      'These files bind an org-subject constant to the DEFAULT org — the assumption that hid ' +
        'tenancy defect D1. Import ORG_A/ORG_B from apps/server/test/fixtures/orgs.ts ' +
        `(or @potion/db) and seed them with seedIsolationOrgs(): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R2 — a test that CLAIMS to be about isolation may not reference the default
// org in its body. Exemptions carry a reason and are re-validated by name.
// ---------------------------------------------------------------------------

const ISOLATION_NAME_RE = /cross-org|isolation|another org|other org|does not leak|leak/i;

/** `relativePath::test name` → why the default org legitimately appears. */
const R2_EXEMPTIONS: Record<string, string> = {};

/** Extract `it('name'…)` / `it("name"…)` blocks with their bodies. */
function testBlocks(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    // Body = up to the next it/test at the same nesting, or 4k chars.
    const next = re.lastIndex;
    const rest = src.slice(next);
    const nextIt = rest.search(/\b(?:it|test)\s*\(\s*['"`]/);
    const body = nextIt === -1 ? rest.slice(0, 4000) : rest.slice(0, nextIt);
    out.push({ name: m[2]!.replace(/\\(.)/g, '$1'), body: src.slice(start, start) + body });
  }
  return out;
}

describe('R2: isolation-named tests do not probe the default org', () => {
  it('every cross-org/isolation test uses non-default subjects (or is justified)', () => {
    const offenders: string[] = [];
    for (const f of testFiles()) {
      const src = readFileSync(f, 'utf8');
      for (const { name, body } of testBlocks(src)) {
        if (!ISOLATION_NAME_RE.test(name)) continue;
        if (!/DEFAULT_ORG_ID/.test(body)) continue;
        const key = `${rel(f)}::${name}`;
        if (R2_EXEMPTIONS[key] !== undefined) continue;
        offenders.push(key);
      }
    }
    expect(
      offenders,
      'These tests claim to test isolation but reference the DEFAULT org in their body. Either ' +
        'use ORG_A/ORG_B from the shared fixture, or add a justified entry to R2_EXEMPTIONS ' +
        `in this file: ${offenders.join(' | ')}`,
    ).toEqual([]);
  });

  it('every exemption is justified AND still resolves to a real test', () => {
    const allKeys = new Set<string>();
    for (const f of testFiles()) {
      for (const { name } of testBlocks(readFileSync(f, 'utf8'))) {
        allKeys.add(`${rel(f)}::${name}`);
      }
    }
    for (const [key, reason] of Object.entries(R2_EXEMPTIONS)) {
      expect(reason.length, `exemption '${key}' has no real reason`).toBeGreaterThan(10);
      // A rename forces re-justification — the same discipline the route
      // inventory applies when a path changes.
      expect(allKeys.has(key), `stale exemption (test renamed or removed): ${key}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// R3 — the positive rule: cross-tenant suites import the shared fixture.
// ---------------------------------------------------------------------------

describe('R3: cross-tenant suites use the shared fixture', () => {
  it('files with isolation-named tests import ORG_A/ORG_B from the fixture', () => {
    const offenders: string[] = [];
    for (const f of testFiles()) {
      const src = readFileSync(f, 'utf8');
      const hasIsolationTest = testBlocks(src).some(({ name }) => ISOLATION_NAME_RE.test(name));
      if (!hasIsolationTest) continue;
      // Exempt when every isolation test in the file is itself exempted (i.e.
      // the file is not really doing tenant isolation).
      const allExempt = testBlocks(src)
        .filter(({ name }) => ISOLATION_NAME_RE.test(name))
        .every(({ name }) => R2_EXEMPTIONS[`${rel(f)}::${name}`] !== undefined);
      if (allExempt) continue;
      const importsFixture =
        /from '\.\/fixtures\/orgs\.js'/.test(src) ||
        /from '\.\.\/fixtures\/orgs\.js'/.test(src) ||
        /from '\.\/test-fixtures\/orgs\.js'/.test(src) ||
        /\bORG_A\b/.test(src);
      if (!importsFixture) offenders.push(rel(f));
    }
    expect(
      offenders,
      `Cross-tenant suites must use the shared org fixture: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the fixture itself refuses the default org as a subject', async () => {
    const { assertNonDefaultSubject, ORG_A, ORG_B } = await import('./fixtures/orgs.js');
    const { DEFAULT_ORG_ID } = await import('@potion/db');
    expect(() => assertNonDefaultSubject(ORG_A, ORG_B)).not.toThrow();
    expect(() => assertNonDefaultSubject(DEFAULT_ORG_ID, ORG_B)).toThrow(/DEFAULT org/);
    expect(() => assertNonDefaultSubject(ORG_A, ORG_A)).toThrow(/DISTINCT/);
  });
});
