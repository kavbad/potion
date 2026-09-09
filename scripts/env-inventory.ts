// THE ENVIRONMENT INVENTORY (P2, external review 2026-09-05).
//
// The review counted "82 env flags in code, 28 in .env.example". The real
// figures, once the scan sees how this repo actually reads env, are worse:
// 100 distinct variables read in shipped source against 29 documented, and
// among the 71 undocumented were STRIPE_SECRET_KEY (whether real money can
// move), REDIS_URL (whether the rate limiter spans replicas), and
// POTION_DEV_AUTH (whether /api/* requires authentication at all).
//
// WHY A SCANNER AND NOT A LIST. A hand-kept list of flags is a list that goes
// stale on the first PR, and the 2026-08-27 incident was precisely a gate
// nobody could see. This derives the set from the source every run, so the
// guard beside it can only be satisfied by a real decision about a real flag.
//
// WHY THE PATTERNS ARE PLURAL. The first version of this scan grepped
// `process.env.X` and reported 136 read / 29 documented — and also claimed
// RESEND_API_KEY, PG_POOL_MAX and every POTION_BREAKER_* knob were never read
// at all. They are: this codebase deliberately reads env through an injected
// `env: NodeJS.ProcessEnv` parameter wherever a value needs to be testable
// (pool.ts, factory.ts, auth.ts, oidc.ts, boot-report.ts). A scan that misses
// that pattern is a guard that lies in both directions.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.turbo']);

/** Every way this repo reaches an environment variable. */
const PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\]/g,
  // The injected-env parameter: `env.POTION_X`, `processEnv.POTION_X`.
  /\b(?:env|processEnv)\.([A-Z][A-Z0-9_]{2,})\b/g,
  /\b(?:env|environment)\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\]/g,
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * The directories that SHIP. Tests and one-off scripts are excluded on
 * purpose: a knob only a test sets is not a thing an operator can get wrong,
 * and folding them in would bury the flags that are.
 */
export function shippedSourceDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const app of ['server', 'dashboard']) {
    dirs.push(join(root, 'apps', app, 'src'), join(root, 'apps', app, 'lib'), join(root, 'apps', app, 'app'));
  }
  for (const pkg of readdirSync(join(root, 'packages'))) {
    dirs.push(join(root, 'packages', pkg, 'src'));
  }
  return dirs;
}

/** Variable name → the shipped files that read it (repo-relative). */
export function scanEnvUsage(root: string): Map<string, string[]> {
  const hits = new Map<string, Set<string>>();
  for (const dir of shippedSourceDirs(root)) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, 'utf8');
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const name = m[1]!;
          const set = hits.get(name) ?? new Set<string>();
          set.add(relative(root, file));
          hits.set(name, set);
        }
      }
    }
  }
  return new Map([...hits.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Names DECLARED in .env.example — an uncommented `NAME=` line.
 *
 * Comments are prose, not declarations. The first version of this accepted a
 * leading `#` so that a commented-out flag would still count as documented,
 * and immediately mis-parsed its own new paragraph: a sentence that wrapped
 * onto a line beginning `NODE_ENV=production REFUSES TO BOOT.` registered
 * NODE_ENV as documented, and the guard then complained that NODE_ENV was in
 * two buckets at once. A flag worth documenting is worth writing on its own
 * line with an empty value.
 */
export function documentedNames(root: string): Set<string> {
  const src = readFileSync(join(root, '.env.example'), 'utf8');
  const names = new Set<string>();
  for (const line of src.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]{2,})=/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

/**
 * Deployment files that consume env directly, without any TypeScript reading
 * it: Caddy's site blocks, compose's `${VAR:?}` interpolation, the Dockerfile.
 *
 * This exists because the guard's dead-knob rule was about to delete a LIVE
 * variable. POTION_ROOT_SITE is read by no TypeScript anywhere — and it is
 * required by `deploy/Caddyfile` for the bare-domain vhost and by compose
 * with `:?`, so removing it from .env.example would have stopped the next
 * deploy dead. Verified by reading those files, not by an exemption list:
 * a knob that stops being consumed there stops being allowed here.
 */
export function deploymentFileNames(root: string): Set<string> {
  const names = new Set<string>();
  for (const rel of ['deploy/Caddyfile', 'deploy/docker-compose.prod.yml', 'Dockerfile']) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    for (const m of src.matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})[}:\s]/g)) names.add(m[1]!);
  }
  return names;
}
