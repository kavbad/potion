// Candidate generation (SPEC §15.1): the template grammar × class-pruned
// registry. Given a FOCUS model (usually a newly scanned alias), generate a
// bounded, deterministic set of recipe candidates:
//
//   1. single(focus)
//   2. cascade — focus slotted into every class-compatible stage position
//      (escalation order cheap → mid → strong, self-report-calibrated)
//   3. composite(start=focus, upgrade=strong-rep) +
//      composite(start=cheap-rep, upgrade=focus)
//   4. draft-verify(draft=focus, verifier=strong-rep) — cheap/mid focus only
//      (a strong-class draft defeats the strategy's cost purpose)
//   5. best-of-n(focus, n=3, judge=judge-rep)
//   6. ensemble(focus + 2 cross-provider same-class peers, judge-pick)
//   7. decompose — OFF by default (prompt-sensitive; includeDecompose to
//      enable), routing {default: cheap-rep}
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
import { strategyHash, type StrategyConfig } from '@potion/core';
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
}

export const DEFAULT_CANDIDATE_BUDGET = 20;
/** Cascade stage escalation threshold (non-final stages). */
export const CASCADE_CONFIDENCE_BELOW = 0.5;
/** Composite mid-stream upgrade threshold (matches the M3 #23 default band). */
export const COMPOSITE_CONFIDENCE_BELOW = 0.6;

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

/** All raw (unpruned) template instantiations for one focus entry. */
function templatesFor(
  focus: ModelRegistryEntry,
  registry: ModelRegistryEntry[],
  includeDecompose: boolean,
  seed: number | undefined,
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
  if (cheapRep && cheapRep.alias !== focus.alias) {
    out.push({
      template: 'composite(start=cheap,upgrade=focus)',
      config: {
        type: 'composite',
        startModel: cheapRep.alias,
        upgradeModel: focus.alias,
        upgradeIf: { confidenceBelow: COMPOSITE_CONFIDENCE_BELOW },
      },
    });
  }

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
    raw = templatesFor(focus, registry, opts.includeDecompose ?? false, opts.seed);
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
