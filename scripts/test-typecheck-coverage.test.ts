// TEST-TYPECHECK COVERAGE — the inventory that keeps this from rotting.
//
// WHY IT EXISTS. Until 2026-09-02 no test file in this monorepo was ever
// typechecked: every package's tsconfig carried `exclude:
// ["src/**/*.test.ts"]`, and apps/server additionally excluded its whole
// `test/` directory. That is not a cosmetic gap. A fixture in
// compound-policy.test.ts declared a cascade strategy as `models: [...]`
// when CascadeConfig is `stages: [...]`; it compiled, sat dormant for as
// long as every test pruned that slow point before execution, and then
// crashed inside runCascade with "Cannot read properties of undefined"
// the first time a relaxed bound let it be selected.
//
// WHAT THIS ASSERTS. Every workspace package that has test files is either
// ENABLED (a tsconfig.test.json wired into its `typecheck` script, so the
// existing `pnpm typecheck` in CI covers its tests) or listed in PENDING
// with a reason. Turning a package off silently, or adding a new package
// whose tests are unchecked, fails here by name — the same discipline the
// route inventory and the mock-eligibility audit use.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Packages whose test files do NOT yet typecheck, with the error count
 * measured when they were surveyed. These are debts, not exemptions: each
 * one is a place where a fixture can drift out of shape unnoticed. Turning
 * one on is: fix the errors, add tsconfig.test.json, extend `typecheck`,
 * delete the row.
 */
const PENDING: Record<string, string> = {
  // Empty, and meant to stay that way: as of 2026-09-02 every package with
  // tests typechecks them. A row here is a debt, not an exemption — it needs
  // a reason and a measured error count, and the assertions below refuse a
  // row for a package that has already been enabled.
};

interface Pkg {
  name: string;
  dir: string;
  hasTests: boolean;
  hasTestConfig: boolean;
  /** The package's `typecheck` script literally runs a tsconfig.test.json. */
  scriptRunsTestConfig: boolean;
  /** Covered by EITHER mechanism — the script, or a main tsconfig that
   * never excluded tests. */
  typecheckCoversTests: boolean;
}

function walkForTests(dir: string): boolean {
  let found = false;
  const visit = (d: string): void => {
    if (found) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (found) return;
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) found = true;
    }
  };
  if (existsSync(dir)) visit(dir);
  return found;
}

function surveyPackages(): Pkg[] {
  const roots = [path.join(REPO_ROOT, 'packages'), path.join(REPO_ROOT, 'apps')];
  const out: Pkg[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = path.join(root, name);
      if (!statSync(dir).isDirectory()) continue;
      const pkgJsonPath = path.join(dir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const typecheck = pkgJson.scripts?.typecheck ?? '';
      // Two legitimate ways to be covered: a dedicated tsconfig.test.json the
      // typecheck script runs (packages whose BUILD config must keep tests out
      // of dist), or a main tsconfig that never excluded tests in the first
      // place (apps/dashboard includes **/*.ts). Demanding the first form from
      // the second kind would add a config that changes nothing.
      const mainConfigPath = path.join(dir, 'tsconfig.json');
      const mainExcludesTests = existsSync(mainConfigPath)
        ? /"exclude"\s*:\s*\[[^\]]*\.test\.ts|"exclude"\s*:\s*\[[^\]]*"test"/.test(
            readFileSync(mainConfigPath, 'utf8'),
          )
        : false;
      out.push({
        name,
        dir,
        // apps/server keeps tests in test/; packages co-locate them in src/.
        hasTests: walkForTests(path.join(dir, 'src')) || walkForTests(path.join(dir, 'test')),
        hasTestConfig: existsSync(path.join(dir, 'tsconfig.test.json')),
        scriptRunsTestConfig: typecheck.includes('tsconfig.test.json'),
        typecheckCoversTests: typecheck.includes('tsconfig.test.json') || !mainExcludesTests,
      });
    }
  }
  return out;
}

/**
 * THE ESCAPE-HATCH RATCHET.
 *
 * Typechecking tests only means something if the tests are not casting their
 * way out of it. `as never` and `as unknown as X` are assignable to anything,
 * so a fixture behind one is checked against nothing — which is exactly how
 * the bugs this sweep found stayed hidden: an EvalItem with a string `prompt`
 * and no clusterId, a Usage missing the very field production aggregates on,
 * a strategy config with a fusion method that does not exist.
 *
 * The four that remain are all legitimate: each injects ONE bad field to
 * prove a runtime guard rejects it (an out-of-vocabulary alert event, two
 * database CHECK constraints, a null db handle), each is scoped to that
 * field so the rest of the object stays checked, and each carries a comment
 * naming the guard. That is the floor, not a deadline. It is a RATCHET: the
 * count may fall, never rise.
 *
 * NOTE on the pattern: the leading \b matters. Without it, "w-as never" in
 * ordinary prose ("the private hop was never fetched") counts as a cast —
 * which is exactly how the first version of this budget came to be 223 when
 * the true number of casts was far lower.
 */
const ESCAPE_HATCH_BUDGET = 4;

/**
 * Every directory holding test files — `scripts/` included, which is where
 * THIS file lives.
 *
 * It was omitted, and that was not harmless: the raw-control-byte check
 * below could not see its own file, and this one had a literal NUL in a
 * comment describing the hazard. `file` reported it as data and grep
 * skipped it silently, so the guard was unauditable by the tools anyone
 * would reach for. A checker that exempts its own directory is a checker
 * you cannot trust about that directory.
 */
const TEST_ROOTS = ['packages', 'apps', 'scripts'];

/**
 * This file quotes both counted patterns by construction — in the regex that
 * finds them and in the prose explaining why they are dangerous — so counting
 * itself would score its own documentation as five casts and force the budget
 * up to hide them. That is the same self-reference the mock-eligibility audit
 * already excludes for its own files.
 *
 * The exemption is deliberately as narrow as it can be: ONE file, and only
 * for the cast count. `scripts/` stays in TEST_ROOTS, so a genuine cast in
 * any other script test is still counted, and the raw-control-byte check
 * below still reads THIS file — which is the check it was actually hiding
 * from when it lived with a literal NUL in it.
 */
const RATCHET_SELF = path.resolve(fileURLToPath(import.meta.url));

function countEscapeHatches(): { total: number; byFile: Array<[string, number]> } {
  const roots = TEST_ROOTS.map((r) => path.join(REPO_ROOT, r));
  const byFile: Array<[string, number]> = [];
  let total = 0;
  const visit = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.test\.tsx?$/.test(entry.name)) {
        if (path.resolve(full) === RATCHET_SELF) continue;
        const src = readFileSync(full, 'utf8');
        const n = (src.match(/\bas never\b|\bas unknown as\b/g) ?? []).length;
        if (n > 0) {
          byFile.push([path.relative(REPO_ROOT, full), n]);
          total += n;
        }
      }
    }
  };
  for (const r of roots) if (existsSync(r)) visit(r);
  byFile.sort((a, b) => b[1] - a[1]);
  return { total, byFile };
}

describe('test-typecheck coverage', () => {
  const pkgs = surveyPackages();

  it('surveys a plausible workspace', () => {
    expect(pkgs.length).toBeGreaterThan(8);
    expect(pkgs.filter((p) => p.hasTests).length).toBeGreaterThan(5);
  });

  it('every package with tests either typechecks them or is a listed debt', () => {
    const unchecked = pkgs
      .filter((p) => p.hasTests && !p.typecheckCoversTests)
      .map((p) => p.name)
      .filter((n) => !(n in PENDING));
    expect(
      unchecked,
      `These packages have test files that NOTHING typechecks. Either add a ` +
        `tsconfig.test.json and extend the package's "typecheck" script to run it, ` +
        `or add the package to PENDING with a reason: ${unchecked.join(', ')}`,
    ).toEqual([]);
  });

  it('an enabled package has BOTH the config and the wiring — never one alone', () => {
    // A tsconfig.test.json nothing runs is worse than none: it looks like
    // coverage in review and checks nothing in CI.
    const orphanConfigs = pkgs.filter((p) => p.hasTestConfig && !p.scriptRunsTestConfig).map((p) => p.name);
    expect(orphanConfigs, 'tsconfig.test.json exists but the typecheck script never runs it').toEqual([]);
    const wiredWithoutConfig = pkgs.filter((p) => p.scriptRunsTestConfig && !p.hasTestConfig).map((p) => p.name);
    expect(wiredWithoutConfig, 'typecheck references a tsconfig.test.json that does not exist').toEqual([]);
  });

  it('type-escape hatches in tests never increase', () => {
    const { total, byFile } = countEscapeHatches();
    expect(
      total,
      total > ESCAPE_HATCH_BUDGET
        ? `New \`as never\` / \`as unknown as\` in test files: ${total} vs a budget of ` +
          `${ESCAPE_HATCH_BUDGET}. A fixture behind one of these is checked against ` +
          `NOTHING, which is how the shape bugs this sweep found stayed hidden. Fix ` +
          `the type instead. Worst offenders: ${byFile.slice(0, 5).map(([f, n]) => `${f} (${n})`).join(', ')}`
        : `The budget is stale — ${total} remain, below ${ESCAPE_HATCH_BUDGET}. Lower ` +
          `ESCAPE_HATCH_BUDGET to ${total} to lock the gain in.`,
    ).toBe(ESCAPE_HATCH_BUDGET);
  });

  // Found the hard way: two test files embedded RAW control bytes (NUL, ESC)
  // as fixture data for control-character handling. That makes the file
  // "binary" to every text tool — `grep` skips such files SILENTLY, so those
  // two were invisible to every audit run across this whole sweep, including
  // the escape-hatch counts above. The runtime value of the escape form is
  // identical, so the escape form costs nothing and keeps the file greppable.
  it('test files are text — no raw control bytes that make tools skip them', () => {
    const roots = TEST_ROOTS.map((r) => path.join(REPO_ROOT, r));
    const binary: string[] = [];
    const visit = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (/\.test\.tsx?$/.test(entry.name)) {
          const buf = readFileSync(full);
          // Anything outside tab/LF/CR that a text tool treats as binary.
          if (buf.some((b) => b === 0 || (b < 9) || (b > 13 && b < 32))) {
            binary.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    for (const r of roots) if (existsSync(r)) visit(r);
    expect(
      binary,
      `These test files contain raw control bytes, so grep and other text ` +
        `tools skip them silently — they are invisible to every audit. Write ` +
        `the characters as escapes ('\\u0000', '\\u001b') instead; the runtime ` +
        `value is identical: ${binary.join(', ')}`,
    ).toEqual([]);
  });

  it('PENDING names only packages that actually exist and still have tests', () => {
    for (const name of Object.keys(PENDING)) {
      const pkg = pkgs.find((p) => p.name === name);
      expect(pkg, `PENDING names '${name}', which is not a package here`).toBeDefined();
      expect(pkg!.hasTests, `PENDING names '${name}' but it has no tests — drop the row`).toBe(true);
      expect(
        pkg!.typecheckCoversTests,
        `'${name}' now typechecks its tests — delete it from PENDING`,
      ).toBe(false);
    }
  });
});
