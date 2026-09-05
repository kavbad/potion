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
import ts from 'typescript';

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
  // The same roots the scans below use (TEST_ROOTS is declared later in the
  // file; this runs at collection time, after the module body). It used to
  // hardcode packages + apps, so tests/* — a real workspace root with a real
  // package in it — was outside the inventory: adding an
  // `exclude: ["src/**/*.test.ts"]` to tests/chaos would have turned its
  // tests off with nothing to notice. A root that holds no package.json
  // (scripts/) is skipped harmlessly by the loop below.
  const roots = TEST_ROOTS.map((r) => path.join(REPO_ROOT, r));
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
 * WHY THE FALL IS ASSERTED TOO, and not merely permitted. A number policed in
 * one direction drifts in the other for free, and a count that DROPS has two
 * causes that look identical from here: the casts went away, or the scanner
 * stopped seeing them. So a fall fails, demanding the budget be lowered
 * deliberately — which forces someone to say which of the two happened.
 *
 * That is not theory. It is the only guard in this repo that has caught a
 * change while it was still on a branch: PR #8 relocated five integration
 * tests out of packages/ and into tests/, which TEST_ROOTS did not list, and
 * the count fell. Nothing had improved — the casts had moved somewhere this
 * file could not look. Recording the lower number would have written down an
 * improvement that never happened AND blinded the ratchet to that directory
 * permanently. A one-sided ratchet would have accepted it in silence.
 *
 * IT COUNTS THE AST, NOT THE TEXT (2026-09-04). A text scan was wrong in
 * both directions, and both errors cost someone a cycle:
 *
 *  - OVER. It read PROSE. "the private hop was never fetched" matched, which
 *    is how this budget was born at 223 when the true count was 4. Adding a
 *    word boundary fixed that case and not the general one: the sentence
 *    "there is no longer a cast here" still scores as a cast, so a file
 *    could not explain its own cleanup without appearing to fail, and THIS
 *    file could not describe the pattern it counts without scoring five.
 *  - UNDER. `x as unknown as T` matched, but a bare `as unknown` did not,
 *    so the scan simply could not see one whole spelling.
 *
 * A parser cannot be talked around by prose: a cast in a comment or a string
 * is not an AsExpression, so no wording makes one appear or disappear. That
 * is strictly stricter than the text scan, which is why this replaces the
 * file-level self-exemption the text version needed rather than keeping it —
 * a real cast in THIS file is now counted like any other.
 *
 * WHAT COUNTS. `as never` always. `as unknown as T` once, at the inner cast.
 * A LONE `as unknown` never: that one TIGHTENS `any` into a type you must
 * narrow before use, so it is the safe idiom, and counting it would push
 * people back toward `any`. Four `JSON.parse(...) as unknown` in the harness
 * and pareto suites are exactly that, and the text scan was blind to them.
 *
 * WHAT IT DOES NOT COUNT, said plainly because a guard that reports a number
 * gets read as coverage of the whole family. A PLAIN `as T` is invisible
 * here, and one hid a real defect on 2026-09-05: mixing-verdict.test.ts built
 * its fixture behind `as MixingFact`, which concealed `family: 'extractive'`
 * — not a ClusterFamily at all — plus three required fields omitted. Seven
 * tests passed the whole time. "The ratchet is at 4" said nothing about it.
 *
 * That omission is deliberate, and the line a peer drew for it is the right
 * one: a cast on a value the RUNTIME produced (`JSON.parse(x) as Shape`,
 * `server.address() as AddressInfo`) is checked by whatever you assert about
 * it next; a cast on a fixture you CONSTRUCT is checked by nothing at all.
 * Counting both would price them the same and push people toward `any`.
 *
 * So this ratchet covers the laundering spellings only. The thing that
 * catches a mis-shaped fixture is the TYPECHECK — which is why the inventory
 * above exists, and why it is worth running as often as the tests rather
 * than trusting a green suite.
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
 *
 * `tests` is the third workspace root (pnpm-workspace.yaml: packages/*,
 * apps/*, tests/*) and was missing for the same reason scripts/ was — the
 * list was written from memory instead of from the workspace. It already
 * holds @potion/chaos-tests' four files, and the branch on PR #8 relocates
 * five cross-package integration tests into it to break seven devDependency
 * cycles that made `pnpm build` fail from a clean checkout. A missing root
 * fails SILENTLY, because it just yields a smaller number — which is the
 * one way this ratchet can lie. PR #8 asserts the list against
 * pnpm-workspace.yaml, which is the right fix and supersedes this note;
 * this entry is here so the gap is closed before that lands, and so the
 * rebase has nothing to drop.
 */
const TEST_ROOTS = ['packages', 'apps', 'scripts', 'tests'];

/** An escape hatch as the PARSER sees it — see ESCAPE_HATCH_BUDGET above. */
function isEscapeHatch(node: ts.Node): boolean {
  if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return false;
  if (node.type.kind === ts.SyntaxKind.NeverKeyword) return true;
  if (node.type.kind !== ts.SyntaxKind.UnknownKeyword) return false;
  // Only the laundering form: `as unknown` feeding another cast.
  const parent = node.parent as ts.Node | undefined;
  return parent !== undefined && (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent));
}

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
        // setParentNodes: true — isEscapeHatch reads node.parent.
        const sf = ts.createSourceFile(
          full,
          readFileSync(full, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          full.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        let n = 0;
        const walk = (node: ts.Node): void => {
          if (isEscapeHatch(node)) n += 1;
          ts.forEachChild(node, walk);
        };
        walk(sf);
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

  /**
   * scripts/ IS NOT A WORKSPACE PACKAGE, so `pnpm -r typecheck` never walked
   * it — 62 source files and 4 test files checked by nothing at all, this
   * guard's own file among them. Turning it on surfaced 63 errors, and they
   * were not cosmetic: observatory-week.ts read `res.frontierPoints`, a field
   * that does not exist, so `earned` was ALWAYS false and an audition could
   * never be recognised as having won a frontier slot; the m1b combined
   * summary omitted abandonedSpendUsd, the number whose own doc says hiding
   * it makes a campaign "under budget" cost more than its ledger says.
   *
   * The survey above cannot see any of that: it walks packages/ and apps/
   * looking for package.json files. So this asserts the wiring directly.
   */
  it('scripts/ has tests too, and the root typecheck actually covers them', () => {
    const scriptsDir = path.join(REPO_ROOT, 'scripts');
    expect(walkForTests(scriptsDir), 'scripts/ has no test files — has this moved?').toBe(true);

    const cfgPath = path.join(REPO_ROOT, 'tsconfig.scripts.json');
    expect(existsSync(cfgPath), 'tsconfig.scripts.json is missing — scripts/ is unchecked again').toBe(true);
    const cfg = readFileSync(cfgPath, 'utf8');
    expect(cfg, 'tsconfig.scripts.json must include scripts/').toMatch(/"include"\s*:\s*\[[^\]]*scripts/);

    // A config nothing runs is worse than none: it reads as coverage and
    // checks nothing. Follow the root `typecheck` script through to the
    // command that names the config.
    const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = rootPkg.scripts ?? {};
    const seen = new Set<string>();
    const runsConfig = (name: string): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const body = scripts[name];
      if (body === undefined) return false;
      if (body.includes('tsconfig.scripts.json')) return true;
      // `pnpm <script>` / `pnpm run <script>` delegation.
      return [...body.matchAll(/pnpm (?:run )?([\w:-]+)/g)].some((m) => runsConfig(m[1]!));
    };
    expect(
      runsConfig('typecheck'),
      'the root "typecheck" script never reaches tsconfig.scripts.json, so CI does not check scripts/',
    ).toBe(true);
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

  // Found the hard way, THREE times: two test files embedded RAW control
  // bytes (NUL, ESC) as fixture data, this file carried a NUL in a comment
  // about the hazard, and apps/server/src/routing/task-shape.ts used a raw
  // SOH as a join separator. A file holding one is "binary" to every text
  // tool — `grep` skips it SILENTLY, no warning, no non-zero exit — so it
  // is invisible to every audit built on grep: the tenancy sweep, the
  // mock-eligibility audit, the escape-hatch count above.
  //
  // Scope is EVERY source file, not just tests. The one that mattered most
  // was production routing code holding org-scoped fingerprints, and a
  // test-only check sailed past it. The escape form ('\u0001') is the same
  // byte at runtime, so this costs nothing and keeps the file readable by
  // the tools people actually audit with.
  it('source files are text — no raw control bytes that make tools skip them', () => {
    const roots = TEST_ROOTS.map((r) => path.join(REPO_ROOT, r));
    const binary: string[] = [];
    const visit = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (/\.(tsx?|mjs|js)$/.test(entry.name)) {
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
      `These source files contain raw control bytes, so grep and other text ` +
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
