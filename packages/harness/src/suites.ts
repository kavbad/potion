// Suite loading (SPEC §5): suites/<suiteId>.jsonl of EvalItem, one JSON object
// per line, validated against the core EvalItemSchema.
//
// M1a quarantine (provenance split):
//   - Lines starting with `//` are COMMENTS and skipped (used for provenance
//     headers such as `// provenance: authored, unvalidated — …`).
//   - Corpus-derived suites live in suites/simulated/ (see its README.md):
//     TEST/CI SIMULATION ONLY. resolveSuite() detects them and marks them
//     `simulated: true`; runEval refuses to run them without `simulatedOk`.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EvalItemSchema, type EvalItem } from '@potion/core';

/** packages/harness/suites (works from both src/ via tsx and dist/ after build). */
export const SUITES_DIR = fileURLToPath(new URL('../suites', import.meta.url));

/** Corpus-derived, mock-coupled suites — TEST/CI SIMULATION ONLY (see README there). */
export const SIMULATED_SUITES_DIR = `${SUITES_DIR}/simulated`;

export interface ResolvedSuite {
  suiteId: string;
  path: string;
  /** True when the suite resolved under suites/simulated/ (mock-corpus-derived). */
  simulated: boolean;
}

function assertValidSuiteId(suiteId: string): void {
  if (!/^[a-z0-9-]+$/.test(suiteId)) {
    throw new Error(`invalid suite id '${suiteId}' (expected [a-z0-9-]+)`);
  }
}

/**
 * Resolve a suite id to its file, checking the authored suites dir first and
 * the quarantined suites/simulated/ dir second. The `simulated` flag tells
 * callers which provenance class they got.
 */
export function resolveSuite(suiteId: string, dir: string = SUITES_DIR): ResolvedSuite {
  assertValidSuiteId(suiteId);
  const direct = `${dir}/${suiteId}.jsonl`;
  if (existsSync(direct)) return { suiteId, path: direct, simulated: false };
  const sim = `${dir}/simulated/${suiteId}.jsonl`;
  if (existsSync(sim)) return { suiteId, path: sim, simulated: true };
  throw new Error(`suite '${suiteId}' not found at ${direct}`);
}

/** Parse + validate a suite file. Lines starting with `//` are comments. */
export function loadSuiteFile(path: string, label: string): EvalItem[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`suite '${label}' not found at ${path}`);
  }
  const items: EvalItem[] = [];
  const lines = text
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.trimStart().startsWith('//'));
  lines.forEach((line, i) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new Error(`suite '${label}' line ${i + 1}: invalid JSON — ${(e as Error).message}`);
    }
    const parsed = EvalItemSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`suite '${label}' line ${i + 1}: invalid EvalItem — ${parsed.error.message}`);
    }
    items.push(parsed.data as EvalItem);
  });
  return items;
}

/** Load an authored (non-simulated) suite by id from `dir`. Does NOT fall
 * back to suites/simulated/ — callers that want resolution + provenance
 * detection use resolveSuite() (runEval does, and gates on `simulated`). */
export function loadSuite(suiteId: string, dir: string = SUITES_DIR): EvalItem[] {
  assertValidSuiteId(suiteId);
  return loadSuiteFile(`${dir}/${suiteId}.jsonl`, suiteId);
}

export function loadSuites(suiteIds: string[], dir: string = SUITES_DIR): EvalItem[] {
  return suiteIds.flatMap((id) => loadSuite(id, dir));
}
