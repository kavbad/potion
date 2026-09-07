// Candidate generation (SPEC §15.1): the template grammar × class-pruned
// registry. Given a FOCUS model (usually a newly scanned alias), generate a
// bounded, deterministic set of recipe candidates:
//
//   1. single(focus)
//   2. cascade — focus slotted into every class-compatible stage position
//      (escalation order cheap → mid → strong, self-report-calibrated)
//   3. composite(start=focus, upgrade=strong-rep) +
//      (composite(start=cheap-rep, upgrade=focus) RETIRED 2026-09-05 — measured
//       worst on both live suites; see the note at its former site)
//   4. draft-verify(draft=focus, verifier=strong-rep) — cheap/mid focus only
//      (a strong-class draft defeats the strategy's cost purpose)
//   5. best-of-n(focus, n=3, judge=judge-rep)
//   6. ensemble(focus + 2 cross-provider same-class peers, judge-pick)
//   7. decompose — OFF by default (prompt-sensitive; includeDecompose to
//      enable), routing {default: cheap-rep}
//   8. synthesized PROGRAMS — OFF by default (includePrograms; env-gated at
//      the worker). Not a template: a bounded enumeration over the compiler
//      IR, emitting only gates the shelf above cannot express. See
//      programCandidates.
//
// Judge-class focus models never answer (mock judge corruption is 1.0 — they
// score, they don't draft): only judge-slot templates (best-of-n / ensemble
// fusion with judge=focus over class-representative answerers) are emitted.
//
// Pruning: dedupe against existingHashes (strategy_configs ∪ recipe_status),
// evaluatedHashes (content-addressed eval-cache cells — already-evaluated
// recipes are skipped rather than re-run), and within the batch itself.
// Per-cycle budget default 20 (SPEC), focus-first ordering = the template
// order above (simplest focus recipes first). Deterministic by construction;
// `seed` (mulberry32) only rotates tie-filled ensemble peers, so identical
// inputs + seed ⇒ identical output.
import {
  compileToProgram,
  MAX_PROGRAM_CALLS,
  programCallCount,
  programModels,
  promptVariantFitsScoring,
  MIN_SELECTABLE_TOOLS,
  SELECT_MIN_PROMPT_CHARS,
  toleratesDeliberation,
  REASONING_EFFORT_PROVIDERS,
  strategyHash,
  type EvalItem,
  type ProgramCheck,
  type ProgramNode,
  type StrategyConfig,
} from '@potion/core';
import {
  ANSWERER_CLASSES,
  classRepresentative,
  crossProviderPeers,
  type AnswererClass,
  type ModelRegistryEntry,
} from './registry.js';
import { mulberry32 } from './rng.js';

/** SPEC §15.1 GenerateOptions (evaluatedHashes/includeDecompose are additive
 * extensions documented above). */
export interface GenerateOptions {
  registry: ModelRegistryEntry[];
  focusAlias?: string;
  existingHashes: Set<string>;
  /** Eval-cache cells: strategy hashes with ANY eval_results at the current
   * prices version — already-evaluated recipes are pruned (SPEC §15.1). */
  evaluatedHashes?: Set<string>;
  /** Max candidates this cycle (SPEC default 20). */
  budget?: number;
  /** Seeded tie-breaks (mulberry32). Omit ⇒ canonical ordering. */
  seed?: number;
  /** Opt in to the prompt-sensitive decompose template. */
  includeDecompose?: boolean;
  /** C2: opt in to SYNTHESIZED programs (compiler IR) alongside the template
   *  shelf. Off by default and env-gated at the worker — a synthesizer that
   *  emits into the live candidate set changes what every cycle spends money
   *  measuring, and that is an operator decision, not a library default. */
  includePrograms?: boolean;
  /** C2 conditioning: the workloads this cycle will be judged on, with what
   *  is already measured on each. Absent ⇒ synthesis falls back to the
   *  registry-only enumeration (unchanged), which is what the single-recipe
   *  and focus-less paths want. */
  workloads?: WorkloadFeatures[];
}

/**
 * What the synthesizer needs to know about ONE kind of work. Every field is
 * derived, never asserted: the scoring kinds and keys come from the cluster's
 * own suite items, the measured models from its published frontier. The
 * worker assembles these (it owns the db); this package stays pure.
 */
export interface WorkloadFeatures {
  clusterId: string;
  /** The scoring kinds observed across this cluster's items — what the answer
   *  IS, stated by the instrument that grades it. */
  scoringKinds: string[];
  /** Top-level keys the answer must carry, when the scoring names them. */
  requiredKeys?: string[];
  /** PRIOR EVIDENCE: single-model aliases already measured on this cluster,
   *  best-quality first. */
  measuredModels?: string[];
  /** PRIOR EVIDENCE, WHOLE: the mechanism currently measured best on this
   *  cluster — not a model drawn out of it. Compiled to the IR and mutated
   *  into new mechanisms; see mutateIncumbent. */
  incumbent?: StrategyConfig;
  /** C4 rung 3: the median prompt size on this cluster, in characters, and
   *  the median number of paragraphs in its largest message. Context
   *  selection only pays where there is context to drop — and "is this a
   *  grounded-answer workload" is answerable from the ITEMS rather than from
   *  a table of cluster names. */
  medianPromptChars?: number;
  medianContextParagraphs?: number;
  /** C4 rung 4: how many tools this workload's items offer. A catalogue is
   *  input tokens on every call, and most of it is irrelevant to any one
   *  request — but only where there IS a catalogue. */
  medianToolCount?: number;
}

/**
 * Derive the item-side workload features from a cycle's suite items. Pure:
 * the worker adds `measuredModels` from the published frontiers, because that
 * half needs the database.
 *
 * REQUIRED KEYS ARE AN INTERSECTION, not a union. A gate is a promise about
 * the WHOLE workload: if one item's answer carries `urgency` and another's
 * does not, requiring `urgency` would send every request of the second kind
 * down the escalation branch forever — a cost increase dressed as a check.
 * The intersection is the set every answer in this cluster must have; an
 * empty one still gates on "is it JSON at all", which is a real check.
 */
export function workloadFeaturesFromItems(items: EvalItem[]): WorkloadFeatures[] {
  const byCluster = new Map<string, { kinds: Set<string>; keys: string[][]; chars: number[]; paras: number[]; tools: number[] }>();
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length === 0 ? 0 : s[Math.floor((s.length - 1) / 2)]!;
  };
  for (const item of items) {
    const e = byCluster.get(item.clusterId) ?? { kinds: new Set<string>(), keys: [], chars: [], paras: [], tools: [] };
    e.kinds.add(item.scoring.kind);
    const chars = item.prompt.reduce((n, m) => n + m.content.length, 0);
    e.chars.push(chars);
    const biggest = item.prompt.reduce((a, b) => (b.content.length > a.content.length ? b : a), item.prompt[0] ?? { content: '' });
    e.paras.push(biggest.content.split(/\n\s*\n/).length);
    e.tools.push(item.tools?.length ?? 0);
    if (item.scoring.kind === 'field-match') {
      e.keys.push(Object.keys(item.scoring.schema));
    } else if (item.scoring.kind === 'field-contains') {
      // Dotted paths address into the object; the JSON check tests TOP-LEVEL
      // membership, so only the first segment is checkable.
      e.keys.push(Object.keys(item.scoring.fields).map((k) => k.split('.')[0]!));
    }
    byCluster.set(item.clusterId, e);
  }
  return [...byCluster.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([clusterId, e]) => {
      const intersection =
        e.keys.length === 0
          ? []
          : e.keys.reduce((acc, ks) => acc.filter((k) => ks.includes(k)), [...new Set(e.keys[0])]);
      return {
        clusterId,
        scoringKinds: [...e.kinds].sort(),
        ...(intersection.length > 0 ? { requiredKeys: [...intersection].sort() } : {}),
        medianPromptChars: median(e.chars),
        medianContextParagraphs: median(e.paras),
        medianToolCount: median(e.tools),
      };
    });
}

/** Scoring that grades MEANING rather than form. A cluster containing any of
 *  these is not deterministically scored, and text-equality gates are
 *  meaningless on it. */
const JUDGED_SCORING = ['llm-judge', 'code-exec'];
/** Scoring that says the answer is a structured object with named fields. */
const STRUCTURED_SCORING = ['field-match', 'field-contains'];

/** Can two models AGREE on this work? Only where the answer is canonical:
 *  normalized text equality between two paragraphs of prose is a coin that
 *  never lands, so the gate would degenerate to "always escalate" — paying
 *  for two calls to always take the third. */
export function canAgreeOn(w: WorkloadFeatures): boolean {
  return w.scoringKinds.length > 0 && !w.scoringKinds.some((k) => JUDGED_SCORING.includes(k));
}

/** Can a deterministic JSON check gate this work? Only where the instrument
 *  says the answer has fields. */
export function canVerifyJsonOn(w: WorkloadFeatures): boolean {
  return w.scoringKinds.some((k) => STRUCTURED_SCORING.includes(k));
}

export const DEFAULT_CANDIDATE_BUDGET = 20;
/** Cascade stage escalation threshold (non-final stages). */
export const CASCADE_CONFIDENCE_BELOW = 0.5;
/** Composite mid-stream upgrade threshold (matches the M3 #23 default band). */
export const COMPOSITE_CONFIDENCE_BELOW = 0.6;
/** C4: below this, the effort escalation asks the same model to think harder.
 *  Deliberately higher than the cascade's 0.5 — buying more thought from a
 *  model you already trust is cheaper than escalating to a bigger one, so it
 *  can afford to fire more often. */
export const EFFORT_CONFIDENCE_TAU = 0.75;
/** C4 rung 3: below this there is no selection to make — dropping one of three
 *  paragraphs is not a compiler decision, it is a coin flip. */
export const MIN_SELECTABLE_PARAGRAPHS = 6;
/** The fractions of the context worth trying. Two points, not a sweep: the
 *  frontier decides which wins, and every extra candidate is real money. */
export function selectionsFor(paragraphs: number): number[] {
  const half = Math.max(1, Math.floor(paragraphs / 2));
  const quarter = Math.max(1, Math.floor(paragraphs / 4));
  return half === quarter ? [half] : [quarter, half];
}

export interface ExplainedCandidate {
  config: StrategyConfig;
  template: string;
}

function cascade(stages: { model: string; escalate?: boolean }[]): StrategyConfig {
  return {
    type: 'cascade',
    stages: stages.map((s, i) =>
      s.escalate && i < stages.length - 1
        ? { model: s.model, escalateIf: { confidenceBelow: CASCADE_CONFIDENCE_BELOW } }
        : { model: s.model },
    ),
    confidenceMethod: 'self-report-calibrated',
  };
}

/**
 * C2 — PROGRAM SYNTHESIS (docs/INFERENCE-COMPILER-PLAN.md).
 *
 * The templates above are a shelf: seven handwritten shapes, instantiated with
 * different models. This is the first thing that WRITES a mechanism — a
 * bounded enumeration over the compiler IR's gate × escalation-target product,
 * emitted as `program` configs that the same gate promotes and the same
 * receipt names.
 *
 * THE RULE THAT KEEPS IT HONEST: synthesize only what the shelf cannot say.
 * Candidate dedupe is by strategy HASH, so a program that means the same thing
 * as a template is a different hash and would be measured twice — paying real
 * money to learn the same fact. So the gate space is exactly the checks with
 * no template equivalent:
 *
 *   · agree(focus, peer)  — two models concur, or the strong one decides.
 *                           No template expresses agreement between peers.
 *   · json(focus)         — a DETERMINISTIC verifier gates escalation. No
 *                           template has a non-model check in the loop; this
 *                           is the shape extraction workloads keep wanting.
 *
 *   · confidence(focus@low) → focus@high — think harder, on the SAME model.
 *     Excluded until C4, because `cascade` with escalateIf.confidenceBelow was
 *     that mechanism. It no longer is: `CascadeStage` is `{model, escalateIf}`
 *     with no params, so a cascade escalates from one MODEL to another and
 *     never from one EFFORT to another. Effort lives on the call node, so the
 *     structural memo reads `call(m, low)` and `call(m, high)` as two calls of
 *     one model — two operating points the shelf has no way to name.
 *
 * Every emitted tree is inside MAX_PROGRAM_CALLS by construction (3 calls
 * worst case) and passes StrategyConfigSchema — the boundary C1 opened.
 */
function programCandidates(
  focus: ModelRegistryEntry,
  registry: ModelRegistryEntry[],
  workloads: WorkloadFeatures[] | undefined,
): ExplainedCandidate[] {
  // Registry-only escalation targets: the class above the focus, then the
  // strong representative. Used when a workload has no measured evidence yet,
  // and for the unconditioned path.
  const pos = ANSWERER_CLASSES.indexOf(focus.cls as AnswererClass);
  const aboveCls = pos >= 0 && pos < ANSWERER_CLASSES.length - 1 ? ANSWERER_CLASSES[pos + 1]! : null;
  const classTargets: { label: string; alias: string }[] = [];
  const addClassTarget = (label: string, entry: ModelRegistryEntry | null): void => {
    if (!entry || entry.alias === focus.alias) return;
    if (classTargets.some((t) => t.alias === entry.alias)) return;
    classTargets.push({ label, alias: entry.alias });
  };
  addClassTarget(aboveCls ?? 'strong', aboveCls ? classRepresentative(registry, aboveCls) : null);
  addClassTarget('strong', classRepresentative(registry, 'strong'));

  // C4: can this focus model's transport carry an effort request at all? A
  // transport that cannot MUST refuse, and a candidate that refuses mid-sweep
  // is a wasted measurement rather than a discovery.
  const effortCapable = (REASONING_EFFORT_PROVIDERS as readonly string[]).includes(focus.provider);

  const emit = (
    targets: { label: string; alias: string }[],
    gates: { agree: boolean; json: boolean },
    requiredKeys: string[] | undefined,
    clusterTag: string,
    scoringKinds: string[] = [],
    promptChars = 0,
    contextParagraphs = 0,
    toolCount = 0,
  ): ExplainedCandidate[] => {
    const out: ExplainedCandidate[] = [];
    // An effort escalation needs no escalation TARGET — the same model is the
    // target — so an empty target list still allows it, when the instrument
    // can take deliberation at all.
    if (targets.length === 0 && !(effortCapable && toleratesDeliberation(scoringKinds))) return out;
    // C4 rung 1, corrected 2026-09-05 by the first live run. Effort buys
    // DELIBERATION, and deliberation breaks an instrument that reads the
    // answer's shape — measured at 0.862 against 0.962 for the same model
    // answering plainly on the extraction suite. Same predicate `step-by-step`
    // uses, because it is the same property; and like instructing, an unknown
    // instrument means no.
    if (effortCapable && scoringKinds.length > 0 && toleratesDeliberation(scoringKinds)) {
      const low: ProgramNode = { op: 'call', model: focus.alias, reasoningEffort: 'low' };
      out.push({
        template: `program:effort-escalation(${clusterTag}low->high,tau=${EFFORT_CONFIDENCE_TAU})`,
        config: {
          type: 'program',
          name: 'effort-escalation',
          body: {
            op: 'if',
            check: { kind: 'confidence', of: low, min: EFFORT_CONFIDENCE_TAU },
            then: low,
            else: { op: 'call', model: focus.alias, reasoningEffort: 'high' },
          },
        },
      });
    }
    // Gate 1 — agreement between the focus and a cross-provider same-class
    // peer. Cross-provider on purpose: two models from one house agreeing is
    // weaker evidence than two houses agreeing, and the peer list is
    // deterministic.
    const [peer] = crossProviderPeers(registry, focus.cls, focus.provider, 1);
    if (gates.agree && peer && targets.length > 0) {
      for (const t of targets) {
        const a: ProgramNode = { op: 'call', model: focus.alias };
        const b: ProgramNode = { op: 'call', model: peer.alias };
        out.push({
          template: `program:consensus-or-escalate(${clusterTag}peer=${peer.alias},escalate=${t.label})`,
          config: {
            type: 'program',
            name: 'consensus-or-escalate',
            body: {
              op: 'if',
              check: { kind: 'agree', of: [a, b] },
              then: { op: 'pick', of: [a, b], by: { kind: 'confidence' } },
              else: { op: 'call', model: t.alias },
            },
          },
        });
      }
    }
    // Gate 2 — a deterministic JSON-shape check on the focus answer. The
    // `then` branch IS the checked node, so the interpreter's structural memo
    // pays for the focus call once: two calls worst case, one when it passes.
    // Gate 6 (C4 rung 4) — SELECT TOOLS OR RETRY. Offer the k most relevant
    // tools, and if the model made NO call, try again with the whole
    // catalogue. The retry is not optional politeness: dropping a paragraph
    // costs answer quality, but dropping the tool the request needed costs the
    // TASK, and the `tool-called` check is what turns that from an
    // undetectable correctness failure into a measured cost.
    //
    // The escalation is the SAME MODEL with every tool, for the same reason
    // select-and-verify escalates to the same model at full context: the
    // hypothesis is "most of this catalogue was irrelevant", and the control
    // for it is the same model seeing all of it.
    if (toolCount >= MIN_SELECTABLE_TOOLS) {
      for (const keep of selectionsFor(toolCount)) {
        const trimmed: ProgramNode = { op: 'call', model: focus.alias, toolSelect: { keepTools: keep } };
        out.push({
          template: `program:select-tools-or-retry(${clusterTag}keep=${keep}/${toolCount})`,
          config: {
            type: 'program',
            name: 'select-tools-or-retry',
            body: {
              op: 'if',
              check: { kind: 'tool-called', of: trimmed },
              then: trimmed,
              else: { op: 'call', model: focus.alias },
            },
          },
        });
      }
    }

    // Gate 5 (C4 rung 3) — SELECT AND VERIFY. Send LESS of the context the
    // request already carries, then check the answer still holds up; escalate
    // to the full-context call when it does not. This is the half of
    // "retrieval" Potion can own — there is nothing to fetch, the context is
    // already here, and the question is how much of it to pay for.
    //
    // The escalation target is deliberately the SAME MODEL AT FULL CONTEXT,
    // not a bigger model: the hypothesis under test is "most of this blob was
    // irrelevant", and the control for that is the same model reading all of
    // it. Escalating to a stronger model instead would confound the two.
    if (contextParagraphs >= MIN_SELECTABLE_PARAGRAPHS && promptChars >= SELECT_MIN_PROMPT_CHARS) {
      for (const keep of selectionsFor(contextParagraphs)) {
        const trimmed: ProgramNode = { op: 'call', model: focus.alias, contextSelect: { keepParagraphs: keep } };
        const check: ProgramCheck = gates.json
          ? { kind: 'json', of: trimmed, ...(requiredKeys && requiredKeys.length > 0 ? { requiredKeys } : {}) }
          : { kind: 'confidence', of: trimmed, min: EFFORT_CONFIDENCE_TAU };
        out.push({
          template: `program:select-and-verify(${clusterTag}keep=${keep}/${contextParagraphs},check=${check.kind})`,
          config: {
            type: 'program',
            name: 'select-and-verify',
            body: { op: 'if', check, then: trimmed, else: { op: 'call', model: focus.alias } },
          },
        });
      }
    }

    // Gate 4 (C4 rung 2) — INSTRUCT AND VERIFY. Where the instrument says the
    // answer is an object, ask for one and check for one: the ask and the
    // check agree, which is a single mechanism no template can state (a
    // cascade stage carries a model, never an instruction). Only where the
    // variant fits the scoring — `json-only` on a canonical-answer workload
    // would break the scorer it is trying to satisfy.
    if (gates.json && promptVariantFitsScoring('json-only', scoringKinds)) {
      for (const t of targets) {
        const asked: ProgramNode = { op: 'call', model: focus.alias, promptVariant: 'json-only' };
        out.push({
          template: `program:instruct-and-verify(${clusterTag}ask=json-only,check=json,escalate=${t.label})`,
          config: {
            type: 'program',
            name: 'instruct-and-verify',
            body: {
              op: 'if',
              check: {
                kind: 'json',
                of: asked,
                ...(requiredKeys && requiredKeys.length > 0 ? { requiredKeys } : {}),
              },
              then: asked,
              else: { op: 'call', model: t.alias },
            },
          },
        });
      }
    }
    if (gates.json) {
      for (const t of targets) {
        const answer: ProgramNode = { op: 'call', model: focus.alias };
        out.push({
          template: `program:verified-cascade(${clusterTag}check=json,escalate=${t.label})`,
          config: {
            type: 'program',
            name: 'verified-cascade',
            body: {
              op: 'if',
              check: {
                kind: 'json',
                of: answer,
                ...(requiredKeys && requiredKeys.length > 0 ? { requiredKeys } : {}),
              },
              then: answer,
              else: { op: 'call', model: t.alias },
            },
          },
        });
      }
    }
    return out;
  };

  // UNCONDITIONED: no workloads given (single-recipe path, focus-less cycles,
  // and every caller predating C2's conditioning). Both gates, class targets.
  if (workloads === undefined || workloads.length === 0) {
    return emit(classTargets, { agree: true, json: true }, undefined, '');
  }

  /**
   * THE MUTATION SOURCE — compile-down's payoff.
   *
   * C2's gate space escalates to a model that measured well. This escalates to
   * THE MECHANISM ALREADY PROVEN BEST ON THIS WORK: try the model under test,
   * and when the gate says its answer is not good enough, fall back to the
   * incumbent entire. Two properties follow, and neither is available to the
   * template shelf:
   *   · quality has a floor by construction — the program can only differ from
   *     the incumbent where the cheap head PASSES its check;
   *   · the fallback is a mechanism, not a model. A cascade stage names a
   *     model; it can never name a cascade.
   *
   * Three refusals, each for a reason:
   *   · an incumbent that does not compile is SKIPPED, never approximated —
   *     `compileToProgram`'s refusal names a missing instruction, and guessing
   *     past it would measure something that is not the incumbent;
   *   · a single-model incumbent produces nothing, because `if gate(focus)
   *     then focus else call(m)` is exactly the gate space above under a
   *     different name, and dedupe-by-hash would not catch the waste if the
   *     escalation target happened to differ;
   *   · a head whose model already appears in the incumbent is refused,
   *     because the structural memo would serve the fallback the very answer
   *     the gate just rejected.
   */
  const mutateIncumbent = (
    w: WorkloadFeatures,
    gates: { agree: boolean; json: boolean },
  ): ExplainedCandidate[] => {
    const mutated: ExplainedCandidate[] = [];
    if (w.incumbent === undefined) return mutated;
    const compiled = compileToProgram(w.incumbent);
    if (!compiled.ok) return mutated;
    const body = compiled.body;
    if (programCallCount(body) < 2) return mutated;
    if (programModels(body).includes(focus.alias)) return mutated;

    const tag = `cluster=${w.clusterId},incumbent=${w.incumbent.type}`;
    const keep = (name: string, template: string, node: ProgramNode): void => {
      if (programCallCount(node) > MAX_PROGRAM_CALLS) return;
      mutated.push({ template, config: { type: 'program', name, body: node } });
    };

    if (gates.json) {
      const head: ProgramNode = { op: 'call', model: focus.alias };
      keep(
        'verified-head-over-incumbent',
        `program:verified-head-over-incumbent(${tag},check=json)`,
        {
          op: 'if',
          check: {
            kind: 'json',
            of: head,
            ...(w.requiredKeys && w.requiredKeys.length > 0 ? { requiredKeys: w.requiredKeys } : {}),
          },
          then: head,
          else: body,
        },
      );
    }
    const [peer] = crossProviderPeers(registry, focus.cls, focus.provider, 1);
    if (gates.agree && peer && !programModels(body).includes(peer.alias)) {
      const a: ProgramNode = { op: 'call', model: focus.alias };
      const b: ProgramNode = { op: 'call', model: peer.alias };
      keep(
        'consensus-head-over-incumbent',
        `program:consensus-head-over-incumbent(${tag},peer=${peer.alias})`,
        {
          op: 'if',
          check: { kind: 'agree', of: [a, b] },
          then: { op: 'pick', of: [a, b], by: { kind: 'confidence' } },
          else: body,
        },
      );
    }
    return mutated;
  };

  // CONDITIONED: one pass per kind of work. A workload that can fire neither
  // ANSWER-SHAPE gate gets no gate programs — synthesizing an agreement gate
  // for a prose workload does not merely waste a measurement, it measures a
  // mechanism guaranteed to take the same branch every time.
  //
  // The effort escalation is NOT an answer-shape gate and was wrongly skipped
  // with them until 2026-09-05. Its check is `confidence` on the model's own
  // output, which is meaningful whatever the answer looks like — so it belongs
  // to the PROVIDER, not to the instrument. Measured on the real code-gen
  // suite, the old ordering emitted zero programs for a `code-exec` workload:
  // reasoning-heavy work, where thinking harder is the most obvious lever
  // there is, got nothing at all because its answers are not JSON.
  const out: ExplainedCandidate[] = [];
  for (const w of workloads) {
    const gates = { agree: canAgreeOn(w), json: canVerifyJsonOn(w) };
    // No skip here. Each gate below already refuses on its own predicate, and
    // the outer guard that used to sit at this line skipped the EFFORT pair
    // along with them — which is how a `code-exec` workload came to emit
    // nothing at all. Adding `&& !effortCapable` would have fixed it and left
    // a dead clause behind, since every provider in
    // REASONING_EFFORT_PROVIDERS is effort-capable today.

    // PRIOR EVIDENCE first: escalate to what has actually measured best on
    // THIS work, not to whatever the price table says represents a class.
    const measured = (w.measuredModels ?? []).filter((m) => m !== focus.alias);
    const targets: { label: string; alias: string }[] = [];
    if (measured[0] !== undefined) targets.push({ label: `measured:${measured[0]}`, alias: measured[0] });
    for (const t of classTargets) {
      if (targets.length >= 2) break;
      if (!targets.some((x) => x.alias === t.alias)) targets.push(t);
    }
    out.push(
      ...emit(
        targets, gates, w.requiredKeys, `cluster=${w.clusterId},`, w.scoringKinds,
        w.medianPromptChars ?? 0, w.medianContextParagraphs ?? 0, w.medianToolCount ?? 0,
      ),
    );
    out.push(...mutateIncumbent(w, gates));
  }
  return out;
}

/** All raw (unpruned) template instantiations for one focus entry. */
function templatesFor(
  focus: ModelRegistryEntry,
  registry: ModelRegistryEntry[],
  includeDecompose: boolean,
  seed: number | undefined,
  includePrograms: boolean,
  workloads: WorkloadFeatures[] | undefined,
): ExplainedCandidate[] {
  const out: ExplainedCandidate[] = [];
  const strongRep = classRepresentative(registry, 'strong');
  const cheapRep = classRepresentative(registry, 'cheap');
  const judgeRep = classRepresentative(registry, 'judge');

  if (focus.cls === 'judge') {
    // Judge-slot recipes only — judge models score, they never answer.
    if (judgeRep) {
      for (const cls of ANSWERER_CLASSES) {
        const answerer = classRepresentative(registry, cls);
        if (answerer) {
          out.push({
            template: `best-of-n(judge=focus,answerer=${cls})`,
            config: { type: 'best-of-n', model: answerer.alias, n: 3, judge: { model: focus.alias } },
          });
        }
      }
      const reps = ANSWERER_CLASSES.map((c) => classRepresentative(registry, c));
      if (reps.every((r) => r !== null)) {
        out.push({
          template: 'ensemble(judge=focus)',
          config: {
            type: 'ensemble',
            models: reps.map((r) => r!.alias),
            fusion: { method: 'judge-pick', judge: { model: focus.alias } },
          },
        });
      }
    }
    return out;
  }

  // 1. single(focus)
  out.push({ template: 'single', config: { type: 'single', model: focus.alias } });

  // 2. cascades — focus at every class-compatible stage.
  const pos = ANSWERER_CLASSES.indexOf(focus.cls as AnswererClass);
  const belowCls = pos > 0 ? ANSWERER_CLASSES[pos - 1]! : null;
  const aboveCls = pos < ANSWERER_CLASSES.length - 1 ? ANSWERER_CLASSES[pos + 1]! : null;
  const belowRep = belowCls ? classRepresentative(registry, belowCls) : null;
  const aboveRep = aboveCls ? classRepresentative(registry, aboveCls) : null;
  if (aboveRep && aboveRep.alias !== focus.alias) {
    out.push({
      template: `cascade(focus→${aboveCls})`,
      config: cascade([{ model: focus.alias, escalate: true }, { model: aboveRep.alias }]),
    });
  }
  if (belowRep && aboveRep && belowRep.alias !== focus.alias && aboveRep.alias !== focus.alias) {
    out.push({
      template: `cascade(${belowCls}→focus→${aboveCls})`,
      config: cascade([
        { model: belowRep.alias, escalate: true },
        { model: focus.alias, escalate: true },
        { model: aboveRep.alias },
      ]),
    });
  }
  if (belowRep && !aboveRep && belowRep.alias !== focus.alias) {
    // Focus is the top answerer class: it terminates the escalation chain.
    out.push({
      template: `cascade(${belowCls}→focus)`,
      config: cascade([{ model: belowRep.alias, escalate: true }, { model: focus.alias }]),
    });
    if (belowCls === 'mid' && cheapRep && cheapRep.alias !== belowRep.alias) {
      out.push({
        template: 'cascade(cheap→mid→focus)',
        config: cascade([
          { model: cheapRep.alias, escalate: true },
          { model: belowRep.alias, escalate: true },
          { model: focus.alias },
        ]),
      });
    }
  }

  // 3. composites.
  if (strongRep && strongRep.alias !== focus.alias) {
    out.push({
      template: 'composite(start=focus,upgrade=strong)',
      config: {
        type: 'composite',
        startModel: focus.alias,
        upgradeModel: strongRep.alias,
        upgradeIf: { confidenceBelow: COMPOSITE_CONFIDENCE_BELOW },
      },
    });
  }
  // RETIRED 2026-09-05: composite(start=cheap-rep, upgrade=focus).
  //
  // Measured worst on BOTH live suites, twice each: 0.895 → 0.642 on
  // extraction (0.768 pooled) and 0.500 [0.310, 0.690] on code-gen, where its
  // interval does not overlap the top three. Nothing else scored below 0.75.
  //
  // ONE CAVEAT, STATED: the cheap representative on those runs was
  // `or-ling-3.0-flash`, which this repo already records as flaky. So the
  // measurement is partly a measurement of that model.
  //
  // It is retired anyway, because the confound IS the template's problem.
  // `classRepresentative` picks the CHEAPEST model in class, so this shape
  // always starts on whatever is cheapest in the price table — while the whole
  // premise of a composite is that the start model usually SUFFICES. Cheapest
  // available is not a proxy for good enough to start on, and the template
  // will keep drawing whatever cheap thing is newest each time the table
  // moves. The sibling composite(start=focus, upgrade=strong) starts on a
  // model the cycle is deliberately testing and scored 0.944 / 1.000 on the
  // same runs; it stays.
  //
  // What replaces it is better founded: C2's mutation source starts on the
  // focus and escalates to the mechanism MEASURED best on that cluster,
  // instead of to a class representative nobody chose.

  // 4. draft-verify — cheap/mid drafts only.
  if ((focus.cls === 'cheap' || focus.cls === 'mid') && strongRep && strongRep.alias !== focus.alias) {
    out.push({
      template: 'draft-verify(draft=focus,verifier=strong)',
      config: { type: 'draft-verify', draftModel: focus.alias, verifierModel: strongRep.alias },
    });
  }

  // 5. best-of-n.
  if (judgeRep) {
    out.push({
      template: 'best-of-n(n=3)',
      config: { type: 'best-of-n', model: focus.alias, n: 3, judge: { model: judgeRep.alias } },
    });
  }

  // 6. ensemble — focus + 2 cross-provider same-class peers (judge-pick).
  if (judgeRep) {
    let peers = crossProviderPeers(registry, focus.cls, focus.provider, 2);
    if (seed !== undefined && peers.length > 1) {
      // Seeded rotation of the deterministic peer list (tie-breaks only).
      const rand = mulberry32(seed);
      const off = Math.floor(rand() * peers.length);
      peers = [...peers.slice(off), ...peers.slice(0, off)];
    }
    if (peers.length === 2) {
      out.push({
        template: 'ensemble(focus+2x-peers)',
        config: {
          type: 'ensemble',
          models: [focus.alias, ...peers.map((p) => p.alias)],
          fusion: { method: 'judge-pick', judge: { model: judgeRep.alias } },
        },
      });
    }
  }

  // 8. synthesized programs — opt-in, and LAST so they never crowd out the
  // simple focus recipes the focus-first budget ordering promises.
  if (includePrograms) out.push(...programCandidates(focus, registry, workloads));

  // 7. decompose — opt-in only.
  if (includeDecompose) {
    out.push({
      template: 'decompose(decomposer=focus)',
      config: {
        type: 'decompose',
        decomposerModel: focus.alias,
        routing: { default: (cheapRep && cheapRep.alias !== focus.alias ? cheapRep : focus).alias },
      },
    });
  }

  return out;
}

/** generateCandidates with per-candidate template labels (cycle-row
 * bookkeeping + tests). */
export function generateCandidatesExplained(opts: GenerateOptions): ExplainedCandidate[] {
  const budget = opts.budget ?? DEFAULT_CANDIDATE_BUDGET;
  if (budget <= 0) return [];
  const registry = opts.registry;

  let raw: ExplainedCandidate[];
  if (opts.focusAlias !== undefined) {
    const focus = registry.find((e) => e.alias === opts.focusAlias);
    if (!focus) return []; // unknown focus alias: nothing to generate
    raw = templatesFor(focus, registry, opts.includeDecompose ?? false, opts.seed, opts.includePrograms ?? false, opts.workloads);
  } else {
    // Focus-less baseline cycle: seed the library with singles over every
    // answerer alias (alias-sorted, deterministic).
    raw = registry
      .filter((e) => e.cls !== 'judge')
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map((e) => ({ template: 'single', config: { type: 'single', model: e.alias } as StrategyConfig }));
  }

  // Prune: batch self-dedupe + existingHashes + eval-cache cells.
  const seen = new Set<string>();
  const out: ExplainedCandidate[] = [];
  for (const cand of raw) {
    if (out.length >= budget) break; // focus-first: template order preserved
    const hash = strategyHash(cand.config);
    if (seen.has(hash)) continue;
    if (opts.existingHashes.has(hash)) continue;
    if (opts.evaluatedHashes?.has(hash)) continue;
    seen.add(hash);
    out.push(cand);
  }
  return out;
}

/** SPEC §15.1 surface: deterministic candidate configs, ≤ budget. */
export function generateCandidates(opts: GenerateOptions): StrategyConfig[] {
  return generateCandidatesExplained(opts).map((c) => c.config);
}
