// Suite format v2 (ROADMAP M1a): provenance-carrying suites that decouple the
// harness from the deterministic mock corpus. A v2 suite is a directory:
//
//   suites/v2/<suiteId>/manifest.json   SuiteManifest (this schema)
//   suites/v2/<suiteId>/items.jsonl     one EvalItem per line (core schema)
//
// The manifest records WHERE the items came from (public benchmark or authored
// in-house, license, upstream URI) so redistribution/attribution obligations
// travel with the data. EvalItem itself is NOT redefined here — items reuse
// the core EvalItemSchema (THE CONTRACT).
import { z } from 'zod';
import {
  EvalItemSchema,
  ScoringMethodSchema,
  type EvalItem,
  type ScoringMethod,
} from '@potion/core';

export type ScoringKind = ScoringMethod['kind'];

export const ScoringKindSchema = z.enum(['exact', 'code-exec', 'field-match', 'llm-judge', 'tool-call']);

/** Where the suite's items came from. Conservative license bookkeeping:
 * anything uncertain must be marked "verify before shipping to customers"
 * (see suites/LICENSES.md). */
export const SuiteSourceSchema = z.object({
  kind: z.enum(['public-benchmark', 'authored']),
  /** Human-readable source name, e.g. "HumanEval (OpenAI)". */
  name: z.string().min(1),
  /** SPDX id when known, otherwise a short conservative note. */
  license: z.string().min(1),
  uri: z.string().url().optional(),
});

/** Suite-level scoring defaults: `default` is applied by adapters when an
 * item carries no scoring of its own; `allowed` is the load-time allowlist —
 * any item whose scoring.kind is not listed fails validation. */
export const SuiteScoringDefaultsSchema = z.object({
  default: ScoringMethodSchema.optional(),
  allowed: z.array(ScoringKindSchema).nonempty().optional(),
});

export const SUITE_ID_RE = /^[a-z0-9-]+$/;

export const SuiteManifestSchema = z.object({
  suiteId: z.string().regex(SUITE_ID_RE, 'suiteId must match [a-z0-9-]+'),
  clusterId: z.string().min(1),
  /** semver — bump when items change so cached eval results stay attributable. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver (x.y.z)'),
  source: SuiteSourceSchema,
  /** 'items.jsonl' (path relative to the manifest) or an inline EvalItem array. */
  items: z.union([z.string().min(1), z.array(EvalItemSchema).nonempty()]),
  scoring: SuiteScoringDefaultsSchema,
  createdAt: z.string().datetime({ offset: true }),
});

export type SuiteManifest = z.infer<typeof SuiteManifestSchema>;
export type SuiteSource = z.infer<typeof SuiteSourceSchema>;

// ---- cluster scoring policy --------------------------------------------------
//
// Which scoring kinds make sense per cluster. Conservative default: seeded
// clusters get an explicit allowlist; unknown clusters fall back to ALL kinds
// (policy is a lint for authored data, not a security boundary).

export const CLUSTER_ALLOWED_SCORING: Readonly<Record<string, readonly ScoringKind[]>> = {
  'code-gen': ['code-exec'],
  'code-review': ['code-exec', 'llm-judge'],
  extraction: ['field-match', 'exact'],
  classification: ['exact', 'field-match'],
  summarization: ['llm-judge'],
  creative: ['llm-judge'],
  'rewrite-edit': ['llm-judge', 'exact'],
  'rag-answer': ['llm-judge', 'field-match'],
  'multi-step-reasoning': ['exact', 'llm-judge'],
  'agentic-tool-use': ['llm-judge', 'field-match', 'tool-call'],
};

export function scoringAllowedForCluster(clusterId: string, kind: ScoringKind): boolean {
  const allowed = CLUSTER_ALLOWED_SCORING[clusterId];
  if (!allowed) return true; // unknown cluster: permissive fallback
  return allowed.includes(kind);
}

/** Scoring kinds that need a reference answer to score at all. code-exec
 * carries its tests inside scoring; llm-judge uses a rubric. */
export function scoringRequiresReference(kind: ScoringKind): boolean {
  return kind === 'exact' || kind === 'field-match';
}

/** Cross-checks shared by the jsonl-authored adapter (ingest time) and the
 * v2 loader (load time). Returns a list of human-readable problems; empty = OK. */
export function crossCheckItem(
  manifest: Pick<SuiteManifest, 'suiteId' | 'clusterId' | 'scoring'>,
  item: EvalItem,
  index: number,
): string[] {
  const where = `item ${index + 1} ('${item.id}')`;
  const problems: string[] = [];
  if (item.clusterId !== manifest.clusterId) {
    problems.push(
      `${where}: clusterId '${item.clusterId}' does not match manifest clusterId '${manifest.clusterId}'`,
    );
  }
  const allowed = manifest.scoring.allowed;
  if (allowed && !allowed.includes(item.scoring.kind)) {
    problems.push(
      `${where}: scoring kind '${item.scoring.kind}' not in manifest scoring.allowed [${allowed.join(', ')}]`,
    );
  }
  if (scoringRequiresReference(item.scoring.kind) && item.reference === undefined) {
    problems.push(`${where}: scoring kind '${item.scoring.kind}' requires a reference`);
  }
  return problems;
}

/** Cluster-policy check (ingest-time lint, stricter than the loader). */
export function clusterPolicyProblems(item: EvalItem, index: number): string[] {
  if (!scoringAllowedForCluster(item.clusterId, item.scoring.kind)) {
    const allowed = CLUSTER_ALLOWED_SCORING[item.clusterId] ?? [];
    return [
      `item ${index + 1} ('${item.id}'): scoring kind '${item.scoring.kind}' not allowed for cluster '${item.clusterId}' (allowed: [${allowed.join(', ')}])`,
    ];
  }
  return [];
}
