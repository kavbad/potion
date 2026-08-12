// The expected classification of EVERY fixture, by BOTH validators.
//
// `parse` is what @potion/lab-spec must say (the enforcement truth).
// `ajv` is what the published JSON Schema must say (the structural contract).
// Where the two columns disagree, `layer` states why: the JSON Schema
// documents SHAPE, and some rejections live in layers JSON Schema cannot
// express (total size, secret material, control characters, the fuel
// day>=run relation, embedded-hash verification). Making that disagreement
// EXPLICIT here — and asserting it in the corpus test — is what keeps the
// published schema from silently claiming to enforce what it cannot. A row
// with divergent columns and no `layer` reason fails the meta-test.
import type { SpecIssueCode } from '../src/types.js';

export interface ExpectedFixture {
  /** What parseHarnessSpecText must produce: 'valid' or the ISSUE CODE that
   * must be present (fails-for-the-right-reason, not merely rejected). */
  parse: 'valid' | SpecIssueCode;
  /** What ajv over harness-spec.schema.json must say. 'unparseable' = the
   * file is not JSON, so the JSON Schema never gets to judge it. */
  ajv: 'valid' | 'invalid' | 'unparseable';
  /** Required whenever parse and ajv disagree. */
  layer?: string;
}

export const EXPECTED: Record<string, ExpectedFixture> = {
  // ---- valid ----
  'valid/minimal-task.json': { parse: 'valid', ajv: 'valid' },
  'valid/standing.json': { parse: 'valid', ajv: 'valid' },
  'valid/full-featured.json': { parse: 'valid', ajv: 'valid' },
  // The boundary pin: scary PROSE validates. The spec layer judges the
  // parser, not intent; the runtime treats spec strings as data.
  'valid/injection-prose.json': { parse: 'valid', ajv: 'valid' },
  'valid/hash-embedded.json': { parse: 'valid', ajv: 'valid' },

  // ---- invalid ----
  'invalid/bad-version.json': { parse: 'unsupported-spec-version', ajv: 'invalid' },
  'invalid/missing-slot.json': { parse: 'schema', ajv: 'invalid' },
  'invalid/unknown-field.json': { parse: 'unknown-field', ajv: 'invalid' },
  'invalid/fuel-no-hardstop.json': { parse: 'schema', ajv: 'invalid' },
  'invalid/negative-fuel.json': { parse: 'schema', ajv: 'invalid' },
  'invalid/day-below-run.json': {
    parse: 'schema',
    ajv: 'valid',
    layer: 'relational constraint (maxUsdPerDay >= maxUsdPerRun) is not expressible in vanilla JSON Schema 2020-12',
  },
  'invalid/bad-fraction.json': { parse: 'schema', ajv: 'invalid' },
  'invalid/standing-with-done.json': { parse: 'unknown-field', ajv: 'invalid' },
  'invalid/empty-name.json': { parse: 'schema', ajv: 'invalid' },

  // ---- adversarial ----
  'adversarial/oversize-total.json': {
    parse: 'oversize-total',
    ajv: 'valid',
    layer: 'total input size is checked on raw text BEFORE parsing; JSON Schema only ever sees parsed values',
  },
  'adversarial/oversize-rule.json': { parse: 'oversize-field', ajv: 'invalid' },
  'adversarial/too-many-checkins.json': { parse: 'too-many-items', ajv: 'invalid' },
  'adversarial/depth-bomb.json': { parse: 'nesting-too-deep', ajv: 'invalid' },
  'adversarial/proto-key.json': { parse: 'dangerous-key', ajv: 'invalid' },
  'adversarial/control-chars.json': {
    parse: 'control-characters',
    ajv: 'valid',
    layer: 'control-character rejection is a security scan; the schema does not pattern-constrain every string',
  },
  'adversarial/secret-openrouter.json': {
    parse: 'secret-material',
    ajv: 'valid',
    layer: 'secret detection is the Step 10 custody rule, enforced by scan, not by shape',
  },
  'adversarial/secret-bearer.json': {
    parse: 'secret-material',
    ajv: 'valid',
    layer: 'secret detection is the Step 10 custody rule, enforced by scan, not by shape',
  },
  'adversarial/secret-env-assignment.json': {
    parse: 'secret-material',
    ajv: 'valid',
    layer: 'secret detection is the Step 10 custody rule, enforced by scan, not by shape',
  },
  'adversarial/hash-tampered.json': {
    parse: 'hash-mismatch',
    ajv: 'valid',
    layer: 'hash verification requires recomputation; a schema can constrain the format of the hash, not its truth',
  },
  'adversarial/malformed.json': { parse: 'malformed-json', ajv: 'unparseable' },
};
