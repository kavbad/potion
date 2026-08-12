// Harness spec (Lab) — the TS types. The zod schemas in schema.ts are the
// enforcement truth; these types are what the rest of the Lab compiles
// against. `Policy` is core's type on purpose: one dial vocabulary (dial
// honesty). Lab-VALID policies are a strict subset of core `Policy` — see
// schema.ts for the subset rule and the test that proves it.
import type { Policy } from '@potion/core';

export interface HarnessBrain {
  /** The dial for ordinary steps — core's existing policy vocabulary. */
  policy: Policy;
  /** Optional override for tool-bearing steps. Exists because of the A2
   * carry-forward (single-strategy-tools partition); ENFORCED in Step 7 at
   * frontier-point selection, carried here so the partition has somewhere
   * to live in the file format. */
  toolPolicy?: Policy | undefined;
}

export type HarnessMission =
  | {
      kind: 'task';
      goal: string;
      /** What "done" means, in plain language. The runtime's done-verifier
       * reads this; a task mission without it is unrepresentable. */
      doneDefinition: string;
      worthPerRunUsd?: number | undefined;
    }
  | {
      /** Standing missions have NO done-definition by design — they are
       * governed by rules and check-ins, not a done-verifier. */
      kind: 'standing';
      goal: string;
    };

export interface HarnessSuperpower {
  /** Catalog reference. NEVER credentials — key-shaped content anywhere in
   * a spec is a typed rejection (security.ts, Step 10's custody rule
   * enforced at the earliest layer). */
  id: string;
  scopes: string[];
  maxSpendUsdPerRun?: number | undefined;
  maxSpendUsdPerDay?: number | undefined;
}

export interface HarnessMemory {
  enabled: boolean;
  /** Per-harness scope only in v1 (the store itself is Step 3). */
  retentionDays?: number | undefined;
}

export interface HarnessFuel {
  maxUsdPerRun: number;
  /** When present, must be ≥ maxUsdPerRun (a day that cannot fund one run
   * is a misconfiguration, not a budget). */
  maxUsdPerDay?: number | undefined;
  /** LITERAL true. A spec cannot opt out of the hard stop — the schema
   * makes "no hard stop" unrepresentable rather than a validator catching
   * it. */
  hardStop: true;
}

export type HarnessCheckIn =
  | { trigger: 'before-external-action' }
  | { trigger: 'on-budget-fraction'; fraction: number }
  | { trigger: 'cron'; schedule: string; question: string };

export interface HarnessSpec {
  /** Format version, literal. Unknown versions are a typed rejection —
   * forward compatibility lives here, not in silently ignored fields. */
  specVersion: 1;
  name: string;
  /** Optional embedded content hash. Excluded from the hashed content;
   * recomputed on parse, mismatch is a typed rejection (tamper-evidence —
   * the F7 content-binding discipline applied to specs). */
  hash?: string | undefined;
  brain: HarnessBrain;
  mission: HarnessMission;
  superpowers: HarnessSuperpower[];
  memory: HarnessMemory;
  rules: string[];
  fuel: HarnessFuel;
  checkIns: HarnessCheckIn[];
}

export type SpecIssueCode =
  | 'malformed-json'
  | 'oversize-total'
  | 'unsupported-spec-version'
  | 'schema'
  | 'unknown-field'
  | 'oversize-field'
  | 'too-many-items'
  | 'control-characters'
  | 'secret-material'
  | 'dangerous-key'
  | 'nesting-too-deep'
  | 'hash-mismatch';

export const ALL_SPEC_ISSUE_CODES: readonly SpecIssueCode[] = [
  'malformed-json',
  'oversize-total',
  'unsupported-spec-version',
  'schema',
  'unknown-field',
  'oversize-field',
  'too-many-items',
  'control-characters',
  'secret-material',
  'dangerous-key',
  'nesting-too-deep',
  'hash-mismatch',
];

export interface SpecIssue {
  code: SpecIssueCode;
  /** JSON-path-ish location ('mission.goal', 'rules[3]', '' for whole-doc). */
  path: string;
  message: string;
}

export type ParseSpecResult =
  | { ok: true; spec: HarnessSpec; hash: string }
  | { ok: false; issues: SpecIssue[] };
