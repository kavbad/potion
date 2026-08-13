// Spec motion — a dial move is a spec edit: parse, replace the slot's
// policy, re-canonicalize, re-hash, and emit a NEW two-way-bound sidecar
// whose choice carries the authority's selected point. The old spec+sidecar
// pair stays valid, hash-bound history (policy-row lifecycle, review
// outcome 2).
import { canonicalJson, sha256 } from '@potion/core';
import { harnessSpecHash, parseHarnessSpecText, type HarnessSpec } from '@potion/lab-spec';
import type { AutopilotChoice, ChoicesSidecar } from '@potion/lab-gen';
import type { DialDomain, DialView } from './geometry.js';

export type MotionResult =
  | { ok: true; specText: string; spec: HarnessSpec; sidecar: ChoicesSidecar }
  | { ok: false; reason: 'spec-invalid'; detail: string };

export function applyDialPosition(opts: {
  specText: string;
  slot: 'brain' | 'tools';
  view: Extract<DialView, { feasible: true }>;
  domain: DialDomain;
  /** The surviving pair's provenance (review finding): choices for OTHER
   * slots are CARRIED into the new sidecar; only the moved slot's choice
   * is replaced. Omitting it (no prior provenance) yields a single-choice
   * sidecar as before. */
  priorSidecar?: ChoicesSidecar;
}): MotionResult {
  const parsed = parseHarnessSpecText(opts.specText);
  if (!parsed.ok) {
    return { ok: false, reason: 'spec-invalid', detail: parsed.issues.map((i) => i.code).join(',') };
  }
  const spec = parsed.spec;
  const moved: HarnessSpec = {
    ...spec,
    brain:
      opts.slot === 'brain'
        ? { ...spec.brain, policy: opts.view.policy }
        : { ...spec.brain, toolPolicy: opts.view.policy },
  };
  delete (moved as { hash?: string }).hash;
  const hash = harnessSpecHash(moved);
  const specText = canonicalJson({ ...moved, hash });
  // Closure gate — motion output is lab-spec-valid or motion is broken.
  const reparsed = parseHarnessSpecText(specText);
  if (!reparsed.ok) {
    throw new Error(`dial motion produced an invalid spec: ${reparsed.issues.map((i) => i.code).join(',')}`);
  }
  const choice: AutopilotChoice = {
    slot: opts.slot === 'brain' ? 'brain.policy' : 'brain.toolPolicy',
    decision: opts.view.policy,
    basis: {
      clusterId: opts.domain.clusterId,
      frontierId: opts.view.frontierId,
      frontierVersion: opts.view.frontierVersion,
      strategyHash: opts.view.strategyHash,
      providerMode: 'live',
      ...(opts.view.suiteContentHash !== undefined
        ? { suiteContentHash: opts.view.suiteContentHash }
        : {}),
    },
    partition: opts.domain.singleOnly ? 'single-only' : 'full',
    alternatives: opts.domain.eligible.length,
  };
  const movedSlot = choice.slot;
  const carried = (opts.priorSidecar?.choices ?? []).filter((c) => c.slot !== movedSlot);
  const choices = [...carried, choice];
  return {
    ok: true,
    specText,
    spec: reparsed.spec,
    sidecar: {
      specHash: harnessSpecHash(reparsed.spec),
      choicesHash: sha256(canonicalJson(choices)),
      choices,
    },
  };
}
