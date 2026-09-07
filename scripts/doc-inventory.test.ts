// THE DOC STALENESS GUARD (P2, external review 2026-09-05).
//
// The review said "~25 stale docs" and did not say what stale meant. Measured
// against three checkable definitions (see doc-inventory.ts):
//
//   dead source-file references   7 across 6 docs   (not 16 — the first scan
//                                                    had a regex bug)
//   ghost env variables           3 across 3 docs
//   naming-directive violations   6 in live copy    (not 119 — the first scan
//                                                    matched the word, not the
//                                                    constructions NAMING.md
//                                                    actually bans)
//
// All fixed except the exemptions below. What no scan finds is the fourth and
// worst kind, a doc whose CLAIMS are stale: SPEC §15.4 still described a
// promotion gate two checkpoints out of date, and the P2.1 section of
// HARDENING-PLAN described a defect in the present tense underneath a note
// saying it was fixed. Those came out of reading, and are listed in
// docs/INFERENCE-COMPILER-PLAN.md.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { deadPathRefs, docFiles, ghostEnvRefs, namingViolations } from './doc-inventory.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A doc may name a file that does not exist when it is PROPOSING it. Every
 * entry says which doc, which path, and why it is a plan rather than a claim.
 */
const PLANNED_PATHS: Record<string, string> = {
  'docs/HARDENING-PLAN.md::packages/core/src/env.ts':
    'P2.2 proposes creating it (one validated config module); the doc is the plan for the file, not a citation of it',
};

/** Names a doc discusses that no code reads — proposals, or retired spellings
 *  being explained as retired. */
const PLANNED_ENV: Record<string, string> = {
  'docs/HARDENING-PLAN.md::POTION_SANDBOX_DEDICATED_UID':
    'proposed in the sandbox hardening item; nothing reads it yet, which is the point of the item',
  'docs/specs/step-13a-deploy.md::POTION_SITE':
    'named only to say it was SPLIT into the three site vars and is now read by nothing — deleting the sentence would delete the explanation',
};

/** Dated records and the directive quoting itself. A 2026-08-23 research note
 *  titled "the router tax" is a record of what was written then; editing it to
 *  comply with a 2026-09-04 directive would falsify the record. */
const NAMING_EXEMPT: Record<string, string> = {
  'docs/AUDIT-2026-08-22.md': 'dated audit record — predates the naming directive and is a record of what was said',
  'docs/research/router-tax-2026-08-23.md': 'dated research note, title included — a record, not live copy',
  'CLAUDE.md': 'states the directive itself ("Potion is a COMPILER, never a router")',
  'FRONTIER.md': "carries the directive's own metaphor (a router picks a road; a compiler designs the route)",
  'docs/INFERENCE-COMPILER.md': 'quotes the phrase in order to reject it',
  'docs/INFERENCE-COMPILER-PLAN.md': 'quotes the review, which used the word',
};

describe('P2: doc staleness', () => {
  it('scans a real corpus — a scan that matched nothing would pass everything', () => {
    expect(docFiles(ROOT).length).toBeGreaterThan(60);
  });

  it('no doc names a source file that does not exist', () => {
    const offenders: string[] = [];
    for (const [doc, refs] of deadPathRefs(ROOT)) {
      for (const ref of refs) {
        if (PLANNED_PATHS[`${doc}::${ref}`] === undefined) offenders.push(`${doc} -> ${ref}`);
      }
    }
    expect(
      offenders,
      `Docs naming files that do not exist. Fix the path, or add it to PLANNED_PATHS ` +
        `with the reason it is a proposal:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no doc names an environment variable nothing reads', () => {
    const offenders: string[] = [];
    for (const [doc, names] of ghostEnvRefs(ROOT)) {
      for (const name of names) {
        if (PLANNED_ENV[`${doc}::${name}`] === undefined) offenders.push(`${doc} -> ${name}`);
      }
    }
    expect(
      offenders,
      `Docs naming env variables no code or deploy file reads:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('live copy does not call Potion a router (docs/NAMING.md, 2026-09-04)', () => {
    const offenders: string[] = [];
    for (const [doc, lines] of namingViolations(ROOT)) {
      if (NAMING_EXEMPT[doc] !== undefined) continue;
      offenders.push(`${doc}:\n    ${lines.join('\n    ')}`);
    }
    expect(offenders, `Naming-directive violations:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('every exemption is live, and carries a real reason', () => {
    const deadKeys = new Set(
      [...deadPathRefs(ROOT)].flatMap(([d, refs]) => refs.map((r) => `${d}::${r}`)),
    );
    for (const [key, why] of Object.entries(PLANNED_PATHS)) {
      expect(deadKeys.has(key), `stale PLANNED_PATHS entry (the path exists now): ${key}`).toBe(true);
      expect(why.length, `PLANNED_PATHS['${key}'] has no real reason`).toBeGreaterThan(30);
    }
    const ghostKeys = new Set(
      [...ghostEnvRefs(ROOT)].flatMap(([d, names]) => names.map((n) => `${d}::${n}`)),
    );
    for (const [key, why] of Object.entries(PLANNED_ENV)) {
      expect(ghostKeys.has(key), `stale PLANNED_ENV entry (something reads it now): ${key}`).toBe(true);
      expect(why.length).toBeGreaterThan(30);
    }
    for (const [, why] of Object.entries(NAMING_EXEMPT)) expect(why.length).toBeGreaterThan(30);
  });

  it('the naming rule reads CONSTRUCTIONS, not the word', () => {
    // "routing decided which requests each strategy saw" is the C5 sentence
    // and it is accurate English about a mechanism. A guard that flagged it
    // would be a guard people learn to suppress — the first version did, on
    // 119 lines across 38 docs.
    const flagged = new Set(namingViolations(ROOT).keys());
    expect(flagged.has('SPEC.md')).toBe(false);
    expect(flagged.has('docs/DEPLOY-RUNBOOK.md')).toBe(false);
  });
});
