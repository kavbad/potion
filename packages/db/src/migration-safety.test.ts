// Structural guards on the migration system itself (F12/F21).
//
// The runner is on the boot path (apps/server/src/context.ts), so a defect
// here is a defect in "does the product start" and "whose evidence is whose".
// Both guards below are meta-tests: they read the migration files rather than
// any single behavior, so the NEXT migration is what they protect.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listMigrationFiles, splitStatements } from './migrate.js';

const DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

describe('F21: splitStatements cannot hang the boot', () => {
  // The old predicate was /^(--[^\n]*\n?)*$/. Every `--` inside a comment
  // line is another place the group can begin an iteration, so an ASCII rule
  // gives exponentially many partitions; on a chunk that then fails to match,
  // the engine backtracks through all of them. The boot HUNG — no error, no
  // log, and because PGlite/WASM pins the event loop, no watchdog could even
  // fire. Found by writing 0033 with a `-- ---- frontiers ----` divider.
  const DIVIDER = '-- ---- frontiers ----------------------------------------------------------';

  it('a divider comment is processed in milliseconds, not never', () => {
    const chunk = `${DIVIDER}\nINSERT INTO evidence_attribution_audit (table_name) SELECT 'frontiers';`;
    const started = Date.now();
    const out = splitStatements(chunk);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).toHaveLength(1);
  });

  it('scales linearly in the number of `--` runs (the exponential case)', () => {
    const nasty = `${'-'.repeat(400)}\nSELECT 1;`;
    const started = Date.now();
    splitStatements(nasty);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still drops comment-only chunks and keeps real ones', () => {
    expect(splitStatements('-- just a note\n-- and another')).toEqual([]);
    expect(splitStatements('   ')).toEqual([]);
    expect(splitStatements('-- note\nSELECT 1;')).toHaveLength(1);
    // A blank line between comments used to defeat the old regex and leak the
    // chunk through as "executable". It is correctly dropped now.
    expect(splitStatements('-- a\n\n-- b')).toEqual([]);
  });

  it('every real migration file parses fast', () => {
    for (const file of listMigrationFiles(DIR)) {
      const started = Date.now();
      splitStatements(readFileSync(`${DIR}/${file}`, 'utf8'));
      expect(Date.now() - started, `${file} parses slowly`).toBeLessThan(1_000);
    }
  });
});

describe('F12 meta-test: no migration may carry an unguarded data statement', () => {
  // The ledger makes re-running impossible, but the habit that produced 0023
  // is what actually cost us. A data statement in a migration is not banned —
  // it must be DECLARED, so that adding one is a decision someone made rather
  // than a line that slipped through review.
  //
  // To add a row here: state what closes the statement, i.e. why running it a
  // second time on a live database is harmless.
  const DECLARED: Record<string, string> = {
    '0003_tenancy.sql':
      'INSERT is ON CONFLICT DO NOTHING; the four UPDATEs target columns this ' +
      'same file then sets NOT NULL, so `WHERE org_id IS NULL` can never match again.',
    '0023_org_frontiers.sql':
      'THE F12 DEFECT ITSELF — kept verbatim as history. Its four UPDATEs target ' +
      'NULLABLE org_id (NULL = platform) and nothing closes them. It is safe only ' +
      'because the ledger runs it once and baselining never re-runs it.',
    '0033_evidence_attribution_repair.sql':
      'The F12 repair. Only touches rows provably impossible (created before the ' +
      'claimed org existed); ambiguous rows are audited, never modified.',
    '0050_supports_vision.sql':
      'G. Sets supports_vision=true only for models with vision-instrument ' +
      'evidence cells (measured, never claimed); touches no other column or ' +
      'row; idempotent. Unknown stays NULL — excluded, like supports_tools.',
    '0049_vision_cell_retag.sql':
      "G. Retags the vision suite's cells (item_id LIKE 'vis-%', a prefix only " +
      'that suite uses) to instrument vision — they landed as default because ' +
      'the instrument derived from the scorer. Idempotent; nothing else matches.',
    '0047_instrument.sql':
      "MIXING M3. Retags the cells scored 'tool-call' (the tool-calling suite, " +
      "24 items × 11 strategies from the 2026-08-23 leg) to instrument 'tools' so " +
      'they are never averaged with text-judged cells. Keyed on scorer, a column ' +
      'only that scorer writes; idempotent; never touches any other row.',
  };
  const DATA_STATEMENT = /(^|\n)\s*(UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s/i;

  it('every file containing a data statement is declared with a reason', () => {
    const undeclared: string[] = [];
    for (const file of listMigrationFiles(DIR)) {
      const text = readFileSync(`${DIR}/${file}`, 'utf8');
      const statements = splitStatements(text).filter((s) => DATA_STATEMENT.test(s));
      if (statements.length > 0 && DECLARED[file] === undefined) undeclared.push(file);
    }
    expect(
      undeclared,
      `Undeclared data statement(s) in: ${undeclared.join(', ')}.\n` +
        'A migration that mutates ROWS runs against a live customer database. ' +
        'Add it to DECLARED with the reason a second run is harmless — or, better, ' +
        'do not write it.',
    ).toEqual([]);
  });

  it('the declaration list has no stale entries', () => {
    for (const file of Object.keys(DECLARED)) {
      expect(listMigrationFiles(DIR), `${file} is declared but no longer exists`).toContain(file);
      const statements = splitStatements(readFileSync(`${DIR}/${file}`, 'utf8'));
      expect(
        statements.some((s) => DATA_STATEMENT.test(s)),
        `${file} is declared as carrying a data statement but no longer does — drop the entry`,
      ).toBe(true);
    }
  });
});
