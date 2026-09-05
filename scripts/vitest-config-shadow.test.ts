// VITEST CONFIG SHADOWING — the root `test` block must actually reach the
// dashboard.
//
// apps/dashboard carries its own vitest.config.ts (it needs the Next '@/'
// alias and the React 19 automatic JSX runtime). A package-level config does
// not MERGE with the root one, it REPLACES it — so every setting in the root
// `test` block has to be copied there by hand, and nothing notices when a new
// one is not.
//
// That has now happened three times, each found only after the setting
// silently failed to apply:
//
//   1. globalSetup — the prices.json write tripwire, the guard that catches a
//      stale dist resurrecting a scan-writer. It was root-only, so the one
//      package whose build writes most eagerly was the one place it did not
//      run.
//   2. testTimeout / hookTimeout (2026-09-03) — set at the root because the
//      real tests take 15-50s and the 5s default was failing runs for being
//      busy rather than broken.
//   3. exclude '**/.claude/**' (PR #8) — .claude/worktrees holds stale copies
//      of the whole repo, so a bare `vitest run <fragment>` collects each test
//      once per worktree and fails on artifacts those copies do not carry.
//
// The dashboard config already carries a comment telling the next person to
// remember. A comment asking a human to remember is what failed all three
// times, so this asserts it instead: anything the root `test` block gains has
// to appear in the dashboard's, with the same value.
//
// This does NOT merge the configs. A shared base is the better end state, but
// both files are edited often and by different people; a guard that fails by
// name is what stops the next silent divergence in the meantime.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rootConfig from '../vitest.config.js';
import dashConfig from '../apps/dashboard/vitest.config.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

type TestBlock = Record<string, unknown>;

function testBlock(cfg: unknown): TestBlock {
  const block = (cfg as { test?: TestBlock }).test;
  if (block === undefined) throw new Error('config has no `test` block');
  return block;
}

/**
 * Compare by MEANING, not by literal text. `globalSetup` names the same file
 * from two different directories, so the strings legitimately differ; a path
 * is equal if it resolves to the same file. Everything else compares as-is.
 */
function normalise(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes('/') && !value.includes('*') ? path.relative(REPO_ROOT, path.resolve(value)) : value;
  }
  if (Array.isArray(value)) return value.map(normalise);
  return value;
}

describe('the dashboard vitest config does not silently drop root settings', () => {
  const root = testBlock(rootConfig);
  const dash = testBlock(dashConfig);

  it('the root config still carries the settings this guard exists to propagate', () => {
    // Guard against becoming vacuous: if the root `test` block were ever
    // emptied, every assertion below would pass while checking nothing.
    expect(Object.keys(root).length, 'the root test block is empty — this guard would be vacuous').toBeGreaterThan(0);
  });

  it('every key in the root `test` block is present in the dashboard config', () => {
    const missing = Object.keys(root).filter((k) => !(k in dash));
    expect(
      missing,
      `apps/dashboard/vitest.config.ts is MISSING root test setting(s): ${missing.join(', ')}. ` +
        'A package-level vitest config REPLACES the root one rather than merging with it, ' +
        'so the dashboard simply runs without these. Copy each one across.',
    ).toEqual([]);
  });

  it('the shared settings have the same VALUE in both, not merely the same key', () => {
    const diverged: string[] = [];
    for (const key of Object.keys(root)) {
      if (!(key in dash)) continue; // reported by the test above
      const a = JSON.stringify(normalise(root[key]));
      const b = JSON.stringify(normalise(dash[key]));
      if (a !== b) diverged.push(`${key}: root ${a} vs dashboard ${b}`);
    }
    expect(
      diverged,
      `The dashboard's copy of a root setting has drifted: ${diverged.join('; ')}. ` +
        'A copy that disagrees is worse than a missing one — the dashboard looks covered and is not.',
    ).toEqual([]);
  });
});
