// Frontier Notes — the deterministic redaction pass (docs/FRONTIER-NOTES.md).
//
// The writer model only ever sees a fact sheet built from public names and
// permitted fields, so in the normal case this pass finds nothing. It exists
// for the abnormal case: a fact sheet bug, a model that pads a draft with
// what it "knows", a new withheld name that the composer missed. Any hit
// fails the issue CLOSED — an issue that cannot be proven clean is not
// published, and the reason is written to the run record.

/**
 * Names (and identifying descriptions) that never appear in a published
 * issue. Matched case-insensitively as whole tokens; separators in the
 * pattern match any run of non-alphanumerics so `solar-pro4`, `solar pro 4`,
 * `solar_pro4` and `SolarPro4` all hit. Add to this list the moment the
 * operator withholds a name; never remove without the operator.
 */
export const NEVER_NAME: readonly string[] = [
  'solar-pro4',
  'solar-pro-4',
  'solar pro',
  'or-solar-pro4',
  'upstage',
  'the korean lab',
  'korean model',
];

/** Patterns that describe mechanism or instrument detail rather than a name. */
const MECHANISM_PATTERNS: readonly { re: RegExp; why: string }[] = [
  { re: /\b(consensus[- ]or[- ]escalate|verified[- ]cascade|confidence[- ]gated|vote3|oracle)\b/i, why: 'mechanism name' },
  { re: /\bconfidence (threshold|cut[- ]?off|gate)\b.*?\b0?\.\d{2,}\b/i, why: 'confidence threshold' },
  { re: /\b(if|when) (the )?(confidence|logprob|agreement) (is |falls |drops )?(below|under|above|over) 0?\.\d+/i, why: 'gate threshold' },
  { re: /\bjudge (model|prompt|rubric)\b/i, why: 'judge detail' },
  { re: /\b(system|user) prompt:/i, why: 'prompt text' },
  { re: /\b[0-9a-f]{16,64}\b/i, why: 'strategy hash' },
  { re: /\b(then|followed by|escalat\w+ to|falls? back to|combin\w+ with)\s+(or-)?[a-z0-9]+(?:[-.][a-z0-9]+)+/i, why: 'mixture recipe' },
];

export interface RedactionHit {
  kind: 'never-name' | 'mechanism';
  match: string;
  why: string;
  offset: number;
}

function tokenPattern(name: string): RegExp {
  // Each alphanumeric run in the name must appear in order, separated by any
  // run of non-alphanumerics (including none). Whole-token on both ends.
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![a-z0-9])${parts.join('[^a-z0-9]*')}(?![a-z0-9])`, 'gi');
}

/** Every place a draft leaks. Empty array ⇒ clean. */
export function findLeaks(text: string, extraNeverName: readonly string[] = []): RedactionHit[] {
  const hits: RedactionHit[] = [];
  for (const name of [...NEVER_NAME, ...extraNeverName]) {
    const re = tokenPattern(name);
    for (const m of text.matchAll(re)) {
      hits.push({ kind: 'never-name', match: m[0], why: `withheld name "${name}"`, offset: m.index ?? 0 });
    }
  }
  for (const { re, why } of MECHANISM_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      hits.push({ kind: 'mechanism', match: m[0], why, offset: m.index ?? 0 });
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

/**
 * The publication gate. Returns the text unchanged when clean; throws with
 * every hit when not — the caller records the reason and holds the issue.
 * There is deliberately no "scrub and publish anyway" mode: a draft that
 * needed scrubbing was written from something it should not have seen.
 */
export function assertPublishable(text: string, extraNeverName: readonly string[] = []): string {
  const hits = findLeaks(text, extraNeverName);
  if (hits.length === 0) return text;
  const lines = hits.slice(0, 12).map((h) => `  ${h.kind} @${h.offset}: "${h.match}" (${h.why})`);
  throw new Error(`frontier-notes: draft is not publishable — ${hits.length} leak(s):\n${lines.join('\n')}`);
}
