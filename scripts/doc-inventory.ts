// THE DOC STALENESS SCAN (P2, external review 2026-09-05).
//
// The review said "~25 stale docs". Staleness needs a CHECKABLE definition or
// it is a matter of taste, so this checks three things a machine can settle:
//
//   1. a doc names a source file that does not exist,
//   2. a doc names a POTION_*-shaped variable no code or deploy file reads,
//   3. a doc calls Potion a router (docs/NAMING.md, binding since 2026-09-04).
//
// It cannot see the fourth and worst kind — a doc whose CLAIMS have gone
// stale, like SPEC §15.4 describing a promotion gate two checkpoints out of
// date. Those are found by reading, and the ones found this pass are listed
// in docs/INFERENCE-COMPILER-PLAN.md.
//
// FIRST-VERSION WARNING, kept because it nearly shipped: the path regex
// spelled its extensions `(?:ts|tsx|...|js|json|...)`. Regex alternation is
// first-match, so `.tsx` matched as `.ts` and `.json` as `.js`, and the scan
// reported 16 dead references across 11 docs. Nine of those were its own bug.
// The real count was 7. A staleness scan that invents staleness is worse than
// none, because the fixes it prompts are edits to correct prose.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.turbo']);

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, match, out);
    else if (match.test(entry)) out.push(p);
  }
  return out;
}

export function docFiles(root: string): string[] {
  return [
    ...walk(join(root, 'docs'), /\.md$/),
    ...readdirSync(root).filter((f) => f.endsWith('.md')).map((f) => join(root, f)),
  ].sort();
}

// LONGEST EXTENSION FIRST — see the warning above.
const PATH_RE =
  /(?:^|[\s`("'[])((?:apps|packages|scripts|deploy|docs|test|src)\/[A-Za-z0-9._/-]+\.(?:tsx|ts|mjs|jsonl|json|js|sql|yml|yaml|md))/g;

/** Paths in docs are written from the repo root OR from a package root. */
function resolveBases(root: string): string[] {
  const bases = [''];
  for (const a of readdirSync(join(root, 'apps'))) bases.push(`apps/${a}`);
  for (const p of readdirSync(join(root, 'packages'))) bases.push(`packages/${p}`);
  return bases;
}

export function deadPathRefs(root: string): Map<string, string[]> {
  const bases = resolveBases(root);
  const alive = (p: string): boolean =>
    // BUILD OUTPUTS ARE NOT DOC STALENESS. A runbook naming
    // `apps/server/dist/worker.js` is naming the command an operator runs, and
    // whether that file exists is a fact about whether the tree happens to be
    // built — not about whether the doc is accurate. Scanning them made this
    // guard pass on CI (which builds first) and fail in a fresh worktree,
    // which is a check that reports the environment rather than the thing it
    // is meant to check.
    p.includes('/dist/') || bases.some((b) => existsSync(join(root, b, p)));
  const out = new Map<string, Set<string>>();
  for (const doc of docFiles(root)) {
    for (const m of readFileSync(doc, 'utf8').matchAll(PATH_RE)) {
      const ref = m[1]!;
      if (alive(ref)) continue;
      const key = relative(root, doc);
      const set = out.get(key) ?? new Set<string>();
      set.add(ref);
      out.set(key, set);
    }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, [...v].sort()]));
}

/** Every env-shaped name any source or deployment file mentions. */
export function namesKnownToCode(root: string): Set<string> {
  const files = [
    ...walk(join(root, 'apps'), /\.(ts|tsx)$/),
    ...walk(join(root, 'packages'), /\.(ts|tsx)$/),
    // `.sh` included (2026-09-12): a shell script is code, and this guard did
    // not think so. scripts/deploy-prod.sh reads POTION_DEPLOY_OFF_MAIN, so
    // documenting it correctly was reported as naming a variable "nothing
    // reads" — the guard calling a real reader invisible. Any operational
    // knob whose only reader is a shell script had the same hole.
    ...walk(join(root, 'scripts'), /\.(ts|mjs|sh)$/),
    ...walk(join(root, 'deploy'), /.*/),
    join(root, 'Dockerfile'),
    join(root, '.env.example'),
  ];
  const known = new Set<string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    // NOT this guard's own files. The exemption list in doc-inventory.test.ts
    // names the very variables it exempts, so scanning it made every ghost
    // look like it had a reader — the exemption erased the finding it was
    // written to record, and the test that checks exemptions are still live
    // is what caught it.
    if (/doc-inventory\.(test\.)?ts$/.test(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/\b((?:POTION|STRIPE|S3|QUEUE|ARTIFACT)_[A-Z0-9_]{2,})\b/g)) {
      known.add(m[1]!);
    }
  }
  return known;
}

export function ghostEnvRefs(root: string): Map<string, string[]> {
  const known = namesKnownToCode(root);
  const out = new Map<string, Set<string>>();
  for (const doc of docFiles(root)) {
    for (const m of readFileSync(doc, 'utf8').matchAll(/\b((?:POTION|STRIPE|S3|QUEUE|ARTIFACT)_[A-Z0-9_]{2,})\b/g)) {
      if (known.has(m[1]!)) continue;
      const key = relative(root, doc);
      const set = out.get(key) ?? new Set<string>();
      set.add(m[1]!);
      out.set(key, set);
    }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * docs/NAMING.md bans specific CONSTRUCTIONS, not the word. "routing decided
 * which requests each strategy saw" is accurate English about a mechanism;
 * "the router artifact" is the product calling itself the thing the directive
 * retired. The first version of this matched /router|routing/ and reported 119
 * lines across 38 docs, nearly all of them legitimate.
 */
const BANNED_NAMING: readonly RegExp[] = [
  /\b(?:the|your|our|its)\s+router\b/i,
  /\bmodel router\b/i,
  /\brouter\s+(?:artifact|page|hash\b(?!_))/i,
  /\brouter\s+(?:decides|picks|chooses|emits|serves)/i,
];
/** Spellings NAMING.md explicitly freezes, plus talking ABOUT the word. */
const NAMING_ALLOWED =
  /router_|\/api\/router|`\/router`|router=v|routerHash|routerVersion|gateway|OpenRouter|auto-?router|other people|competitor|their router|most AI router|never (?:called )?a router|not a router|never a router|A router picks|retired/i;

export function namingViolations(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const doc of docFiles(root)) {
    const rel = relative(root, doc);
    if (rel === 'docs/NAMING.md') continue;
    readFileSync(doc, 'utf8').split('\n').forEach((line, i) => {
      if (NAMING_ALLOWED.test(line)) return;
      if (!BANNED_NAMING.some((re) => re.test(line))) return;
      const arr = out.get(rel) ?? [];
      arr.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
      out.set(rel, arr);
    });
  }
  return out;
}
