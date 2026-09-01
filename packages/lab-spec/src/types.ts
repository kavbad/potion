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
      /** P5: the standing SHAPE. Absent = reporter; 'watchdog' = mostly
       * silent, fires only on a true condition (see schema). */
      shape?: 'watchdog' | undefined;
    };

export interface HarnessSuperpower {
  /** Catalog reference. NEVER credentials — key-shaped content anywhere in
   * a spec is a typed rejection (security.ts, Step 10's custody rule
   * enforced at the earliest layer). */
  id: string;
  scopes: string[];
  maxSpendUsdPerRun?: number | undefined;
  maxSpendUsdPerDay?: number | undefined;
  /** Step 12: the per-(run, tool) CALL ceiling. Before this existed the
   * only call cap was the library default (DEFAULT_TOOL_CAPS.maxCalls), so
   * a caller who authorised "5 tool calls" — as the live leg's operator did
   * — had no way to say it, and the run silently used 20. A cap you cannot
   * configure is not a cap the operator agreed to. */
  maxCalls?: number | undefined;
}

export interface HarnessMemory {
  enabled: boolean;
  /** Per-harness scope only in v1 (the store itself is Step 3). */
  retentionDays?: number | undefined;
  /** P3: structured beat working set for standing workers (see schema). */
  beat?: boolean | undefined;
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
  | { trigger: 'cron'; schedule: string; question: string }
  /** P5 event triggers: a secret webhook inlet, and scheduler-polled
   * feed-change wakeups (see schema for the laws). */
  | { trigger: 'webhook' }
  | { trigger: 'feed-change'; url: string };

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
  /** P1 (the mouth): the output contract. When present, the runtime's
   * completion law requires the final answer of a standing check to BE the
   * deliverable — parsed and schema-checked before the run may complete. */
  contract?: { type: 'brief' } | undefined;
  /** C-3: the operator's exemplar — the standard the deliverable must hit. */
  exemplar?: string | undefined;
  /** X4: fan-out — helper sub-runs under one fuel tree (see schema). */
  fanOut?: { maxWorkers: number } | undefined;
  /** W1 (2026-08-31): the Action Constitution — per-action-class maximum
   * authority, carried by the worker itself and hash-bearing (changing the
   * leash is a different worker). 'earnable' = autonomy can be earned via
   * the graduation path; 'ask-forever' = approvable each time, autonomous
   * never (maps to the never-graduates tier); 'barred' = the class never
   * runs at all. Absent entry = 'earnable' with a supervised birth. */
  constitution?: Array<{ action: string; maxAuthority: 'earnable' | 'ask-forever' | 'barred'; note?: string | undefined }> | undefined;
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
