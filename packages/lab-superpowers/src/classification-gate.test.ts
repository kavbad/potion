// THE CLASSIFICATION-DIFF GATE (Step 11 review addition 2) — pore removal
// is never a silent edit.
//
// The committed baseline (baseline/classification.json) records every
// package's version, content hash, and per-tool action. Reclassifying a
// tool act → read REMOVES a permission prompt; so does deleting an act
// tool. Either fails this suite unless BOTH the package version and its
// content hash moved in the same commit — the deliberate, visible
// declaration that the author knew.
import { describe, expect, it } from 'vitest';
import { CATALOG } from './catalog.js';
import {
  buildBaseline,
  CLASSIFICATION_BASELINE,
  diffClassification,
  SilentPoreRemovalError,
  type BaselineEntry,
} from './classification-gate.js';
import { packageContentHash, type SuperpowerPackage } from './format.js';

/** Mutate one package as a would-be silent edit. */
function reclassify(pkg: SuperpowerPackage, toolName: string, action: 'read' | 'act'): SuperpowerPackage {
  return { ...pkg, tools: pkg.tools.map((t) => (t.name === toolName ? { ...t, action } : t)) };
}

describe('the committed baseline agrees with the catalog', () => {
  it('every package is in the baseline, with a matching version + content hash', () => {
    expect(Object.keys(CLASSIFICATION_BASELINE).length).toBe(CATALOG.length);
    for (const pkg of CATALOG) {
      const entry = CLASSIFICATION_BASELINE[pkg.id];
      expect(entry, `${pkg.id} missing from the classification baseline — run \`pnpm --filter @potion/lab-superpowers baseline\``).toBeDefined();
      expect(entry!.version).toBe(pkg.version);
      expect(entry!.contentHash, `${pkg.id}: content hash drifted from the baseline`).toBe(
        packageContentHash(pkg),
      );
    }
  });

  it('NO package has a silent pore removal against the baseline (the standing gate)', () => {
    for (const pkg of CATALOG) {
      const diff = diffClassification(pkg);
      expect(
        diff.silentPoreRemoval,
        `${pkg.id}: pore removal without a version+hash bump — ${diff.poreRemovals.join('; ')}`,
      ).toBe(false);
    }
  });

  it('the baseline regenerates deterministically (same catalog → same bytes)', () => {
    expect(JSON.stringify(buildBaseline(CATALOG))).toBe(JSON.stringify(buildBaseline(CATALOG)));
  });
});

describe('the gate CATCHES a silent pore removal (non-vacuous)', () => {
  const github = CATALOG.find((p) => p.id === 'github')!;
  const actTool = github.tools.find((t) => t.action === 'act')!;

  it('act → read with NO version bump is flagged as a silent pore removal', () => {
    const edited = reclassify(github, actTool.name, 'read');
    const diff = diffClassification(edited);
    expect(diff.poreRemovals.length).toBeGreaterThan(0);
    expect(diff.poreRemovals[0]).toContain('the pore stops firing');
    expect(diff.hashChanged).toBe(true); // the content moved…
    expect(diff.versionChanged).toBe(false); // …but nobody declared it
    expect(diff.silentPoreRemoval).toBe(true); // → the suite fails
  });

  it('act → read WITH a version bump passes — the deliberate, declared edit', () => {
    const edited = { ...reclassify(github, actTool.name, 'read'), version: '2.0.0' };
    const diff = diffClassification(edited);
    expect(diff.poreRemovals.length).toBeGreaterThan(0);
    expect(diff.versionChanged).toBe(true);
    expect(diff.hashChanged).toBe(true);
    expect(diff.silentPoreRemoval).toBe(false);
  });

  it('a version bump ALONE cannot hide a pore removal (the hash must move too)', () => {
    // A hand-edited baseline claiming the new hash while the content did not
    // change: the gate reads the CONTENT, so a stale hash cannot be laundered.
    const base: Record<string, BaselineEntry> = {
      github: {
        version: '1.0.0',
        contentHash: packageContentHash(github),
        actions: Object.fromEntries(github.tools.map((t) => [t.name, t.action])),
      },
    };
    const versionOnly = { ...github, version: '1.1.0' };
    const diff = diffClassification(versionOnly, base);
    expect(diff.poreRemovals).toEqual([]); // nothing was reclassified
    expect(diff.hashChanged).toBe(false); // content identical → hash identical
  });

  it('REMOVING an act tool is a pore removal too', () => {
    const edited = { ...github, tools: github.tools.filter((t) => t.name !== actTool.name) };
    const diff = diffClassification(edited);
    expect(diff.poreRemovals.some((r) => r.includes('act tool removed'))).toBe(true);
    expect(diff.silentPoreRemoval).toBe(true);
  });

  it('ADDING a pore (read → act) is always allowed, no declaration required', () => {
    const readTool = github.tools.find((t) => t.action === 'read')!;
    const edited = reclassify(github, readTool.name, 'act');
    const diff = diffClassification(edited);
    expect(diff.poreRemovals).toEqual([]);
    expect(diff.silentPoreRemoval).toBe(false);
    expect(diff.otherChanges.some((c) => c.includes('a pore was ADDED'))).toBe(true);
  });

  it('a NEW package passes (nothing to remove) and joins the baseline on regeneration', () => {
    const fresh = { ...github, id: 'brand-new-connector' };
    const diff = diffClassification(fresh);
    expect(diff.silentPoreRemoval).toBe(false);
    expect(diff.otherChanges[0]).toContain('new package');
  });
});

describe('REGENERATION cannot launder a pore removal (Step 11 review finding)', () => {
  const github = CATALOG.find((p) => p.id === 'github')!;
  const actTool = github.tools.find((t) => t.action === 'act')!;

  it('regenerating the baseline after a SILENT act→read edit THROWS — the fix-it command refuses too', () => {
    // The hole the review found: the suite failed on hash drift and told the
    // author to regenerate; regeneration rewrote version+hash+actions from
    // the mutated catalog, and every check then passed with the version
    // untouched. The regeneration WAS the laundering path. Now it refuses.
    const edited = reclassify(github, actTool.name, 'read');
    expect(() => buildBaseline([edited])).toThrow(SilentPoreRemovalError);
    expect(() => buildBaseline([edited])).toThrow(/without a version bump/);
  });

  it('regenerating WITH the version bump succeeds — the declared act is still easy', () => {
    const declared = { ...reclassify(github, actTool.name, 'read'), version: '2.0.0' };
    const out = buildBaseline([declared]);
    expect(out['github']!.version).toBe('2.0.0');
    expect(out['github']!.actions[actTool.name]).toBe('read');
  });

  it('regenerating a REMOVED act tool without a bump also refuses', () => {
    const edited = { ...github, tools: github.tools.filter((t) => t.name !== actTool.name) };
    expect(() => buildBaseline([edited])).toThrow(SilentPoreRemovalError);
  });

  it('ordinary regeneration (no pore change) still works — the gate is not a wall', () => {
    expect(() => buildBaseline(CATALOG)).not.toThrow();
    expect(Object.keys(buildBaseline(CATALOG)).length).toBe(CATALOG.length);
  });

  it('a package with TWO act tools: removing one is caught even though another remains', () => {
    // The review noted the accidental backstop (every package has exactly one
    // act tool, so a mini-eval "no act tool visible" failure fired). This pins
    // the gate WITHOUT that backstop.
    const twoActs = {
      ...github,
      tools: [...github.tools, { ...actTool, name: 'second_act_tool' }],
    };
    const priorBaseline = buildBaseline([twoActs], {});
    const droppedOne = { ...twoActs, tools: twoActs.tools.filter((t) => t.name !== 'second_act_tool') };
    expect(() => buildBaseline([droppedOne], priorBaseline)).toThrow(SilentPoreRemovalError);
    const diff = diffClassification(droppedOne, priorBaseline);
    expect(diff.silentPoreRemoval).toBe(true);
  });
});
