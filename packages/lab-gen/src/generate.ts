// Orchestration: interview answers → (validated spec + hash-bound choices)
// | draft-with-typed-gaps | typed refusal. An INVALID spec is
// unrepresentable as an output: the final gate parses through
// @potion/lab-spec and THROWS on failure (a generator bug the property
// test surfaces loudly) rather than returning a refusal that would let the
// bug hide inside a passing suite.
import { canonicalJson, sha256, type Frontier } from '@potion/core';
import {
  harnessSpecHash,
  parseHarnessSpecText,
  scanRawValue,
  SPEC_LIMITS,
  type HarnessSpec,
} from '@potion/lab-spec';
import type { ServingClientLike } from '@potion/lab-runtime';
import { fillBrainSlot, type AutopilotChoice, type GenerationGap } from './autopilot.js';
import { assignCluster } from './cluster.js';
import { accountSlug, assembleSpec, recipeRules, sanitizeVerbatim, specToText } from './assemble.js';
import { extractMission, type Extraction } from './extract.js';
import type { InterviewAnswers, TaxonomyCluster } from './interview.js';

/** Provenance sidecar, BOUND to the spec by content hash (review outcome
 * 2): an edited spec visibly orphans its provenance. */
export interface ChoicesSidecar {
  specHash: string;
  /** sha256(canonicalJson(choices)) — the binding is TWO-way (review
   * finding): an edited spec orphans the sidecar AND an edited sidecar
   * (rewritten basis, emptied choices) is detected against itself. */
  choicesHash: string;
  choices: AutopilotChoice[];
  /** The work PROFILE — the kinds of work the mission contains, primary
   * first (extraction's alsoClusters, deduped by code). Interpretation
   * provenance, not spec law: serving routes each step per-request
   * regardless; this records what the build READ in the mission. */
  workProfile?: TaxonomyCluster[];
  /** Set by the respec path (operator-edited spec): the catalog row this
   * spec was edited from. An operator-authored sidecar carries no
   * autopilot choices — the orphaning is the design, this field names it. */
  editedFrom?: string;
}

export interface DraftSpec {
  /** Deterministic slots filled so far; the brain slot is the open one. */
  answers: InterviewAnswers;
  extraction: Extraction | null;
}

export type GenerationResult =
  | { kind: 'complete'; specText: string; spec: HarnessSpec; sidecar: ChoicesSidecar }
  | { kind: 'draft'; partial: DraftSpec; gaps: GenerationGap[] }
  | {
      kind: 'refused';
      reason: 'secret-in-answers' | 'extraction-unparseable' | 'serving-error' | 'invalid-worth' | 'answers-too-large';
      detail: string;
    };

export class GeneratorInvariantError extends Error {
  constructor(detail: string) {
    super(`generator invariant violated (closure bug): ${detail}`);
    this.name = 'GeneratorInvariantError';
  }
}

export interface GenerateDeps {
  client: ServingClientLike;
  /** Injected frontier read (platform scope) — db wiring stays at the
   * edges (CLI/walkthrough); the generator core is pure of the database. */
  loadFrontier: (clusterId: TaxonomyCluster) => Promise<Frontier | null>;
}

export async function generateSpec(answers: InterviewAnswers, deps: GenerateDeps): Promise<GenerationResult> {
  // Custody at the EARLIEST layer: key-shaped content in answers refuses
  // BEFORE any model call — secrets neither reach serving nor a spec.
  const secretHits = scanRawValue(answers).filter((i) => i.code === 'secret-material');
  if (secretHits.length > 0) {
    return {
      kind: 'refused',
      reason: 'secret-in-answers',
      detail: secretHits.map((i) => i.path).join(', '),
    };
  }

  // Deterministic answer validation (pre-spend review findings): degenerate
  // answers are TYPED refusals, never crashes and never silent truncation.
  // worthUsd: lab-spec requires positive on the copied field, and NaN even
  // survives a clamp — refuse, don't launder.
  if (!Number.isFinite(answers.worthUsd) || answers.worthUsd <= 0) {
    return {
      kind: 'refused',
      reason: 'invalid-worth',
      detail: `worth must be a positive dollar amount, got ${String(answers.worthUsd)}`,
    };
  }
  // Governance overflow: truncated governance is corrupted governance — a
  // rule the user wrote must arrive whole or the generation must say why.
  const constraints = answers.constraints ?? [];
  if (constraints.length > SPEC_LIMITS.MAX_RULES) {
    return { kind: 'refused', reason: 'answers-too-large', detail: `${constraints.length} rules exceeds the ${SPEC_LIMITS.MAX_RULES}-rule cap` };
  }
  const longRule = constraints.find((r) => sanitizeVerbatim(r).length > SPEC_LIMITS.MAX_RULE_CHARS);
  if (longRule !== undefined) {
    return { kind: 'refused', reason: 'answers-too-large', detail: `a rule exceeds ${SPEC_LIMITS.MAX_RULE_CHARS} characters` };
  }
  // Recipe fields become rules with a short named prefix — the same
  // truncated-governance doctrine applies: arrive whole or refuse.
  const RECIPE_PREFIX_BUDGET = 20;
  for (const [field, value] of [['qualityBar', answers.qualityBar], ['produces', answers.produces]] as const) {
    if (value !== undefined && sanitizeVerbatim(value).length > SPEC_LIMITS.MAX_RULE_CHARS - RECIPE_PREFIX_BUDGET) {
      return { kind: 'refused', reason: 'answers-too-large', detail: `${field} exceeds ${SPEC_LIMITS.MAX_RULE_CHARS - RECIPE_PREFIX_BUDGET} characters` };
    }
  }
  if (constraints.length + recipeRules(answers).length > SPEC_LIMITS.MAX_RULES) {
    return { kind: 'refused', reason: 'answers-too-large', detail: `rules plus recipe fields exceed the ${SPEC_LIMITS.MAX_RULES}-rule cap` };
  }
  if (new Set(answers.accounts.map(accountSlug)).size > SPEC_LIMITS.MAX_SUPERPOWERS) {
    return { kind: 'refused', reason: 'answers-too-large', detail: `more than ${SPEC_LIMITS.MAX_SUPERPOWERS} distinct accounts` };
  }

  const extracted = await extractMission(deps.client, answers);
  if (!extracted.ok) {
    return { kind: 'refused', reason: extracted.reason, detail: extracted.detail };
  }
  const extraction = extracted.extraction;

  // An explicit operator answer to the cluster question is authoritative —
  // asking and then second-guessing the answer would make the draft loop
  // unclosable. All refusal gates above still ran first.
  const assignment =
    answers.clusterChoice !== undefined
      ? ({ outcome: 'assigned', clusterId: answers.clusterChoice, basis: 'operator-answer', lexicalScore: 0 } as const)
      : assignCluster(answers.goal, extraction.clusterHint);
  if (assignment.outcome === 'uncertain') {
    return {
      kind: 'draft',
      partial: { answers, extraction },
      gaps: [{ code: 'cluster-uncertain', candidates: assignment.candidates, question: assignment.question }],
    };
  }

  const frontier = await deps.loadFrontier(assignment.clusterId);
  const filled = fillBrainSlot({
    clusterId: assignment.clusterId,
    frontier,
    toolBearing: answers.accounts.length > 0,
  });
  if (!filled.ok) {
    return { kind: 'draft', partial: { answers, extraction }, gaps: [filled.gap] };
  }

  const spec = assembleSpec(answers, extraction, filled.policy);
  // Post-transform custody (review finding): sanitation or slug-joining can
  // CREATE a key-shaped pattern the raw scan missed (whitespace-dependent
  // secret patterns completed by control-char replacement). Scan the
  // ASSEMBLED spec — hits are the same typed refusal, never a crash.
  const assembledSecrets = scanRawValue(spec).filter((i) => i.code === 'secret-material');
  if (assembledSecrets.length > 0) {
    return { kind: 'refused', reason: 'secret-in-answers', detail: assembledSecrets.map((i) => i.path).join(', ') };
  }
  const specText = specToText(spec);
  // Aggregate size gate (review finding): every per-field cap can pass while
  // the serialized whole exceeds lab-spec's MAX_TOTAL_BYTES.
  if (Buffer.byteLength(specText, 'utf8') > SPEC_LIMITS.MAX_TOTAL_BYTES) {
    return { kind: 'refused', reason: 'answers-too-large', detail: `assembled spec is ${Buffer.byteLength(specText, 'utf8')} bytes (cap ${SPEC_LIMITS.MAX_TOTAL_BYTES})` };
  }
  // The closure gate: the file we emit is the file lab-spec accepts.
  const parsed = parseHarnessSpecText(specText);
  if (!parsed.ok) {
    throw new GeneratorInvariantError(
      `assembled spec failed validation: ${parsed.issues.map((i) => i.code).join(',')}`,
    );
  }
  const choices = [filled.choice];
  // The work profile: primary first, then the extraction's alsoClusters —
  // deduped by code, the enum bound at the schema. A one-kind mission
  // yields a one-entry profile (that fact is information too).
  const workProfile: TaxonomyCluster[] = [
    assignment.clusterId,
    ...(extraction.alsoClusters ?? []).filter((c, i, arr) => c !== assignment.clusterId && arr.indexOf(c) === i),
  ];
  return {
    kind: 'complete',
    specText,
    spec: parsed.spec,
    sidecar: { specHash: harnessSpecHash(spec), choicesHash: sha256(canonicalJson(choices)), choices, workProfile },
  };
}

/** Review outcome 2: the binding check. An edited spec's recomputed hash no
 * longer matches the sidecar — its provenance is visibly orphaned. */
export function verifyChoicesBinding(
  specText: string,
  sidecar: ChoicesSidecar,
): { bound: true } | { bound: false; reason: string } {
  const parsed = parseHarnessSpecText(specText);
  if (!parsed.ok) return { bound: false, reason: 'spec no longer parses' };
  const recomputed = harnessSpecHash(parsed.spec);
  if (recomputed !== sidecar.specHash) {
    return { bound: false, reason: `spec hash ${recomputed.slice(0, 12)}… != sidecar ${sidecar.specHash.slice(0, 12)}… — provenance orphaned by edit` };
  }
  const choicesRecomputed = sha256(canonicalJson(sidecar.choices));
  if (choicesRecomputed !== sidecar.choicesHash) {
    return { bound: false, reason: 'choices content does not match its own hash — sidecar tampered, provenance orphaned' };
  }
  return { bound: true };
}
