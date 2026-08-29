// P3 (2026-08-28) — THE BEAT WORKING SET. A standing worker that wakes on a
// cadence loses its thread between checks: blob memory "hopes" it re-reports
// nothing and re-learns nothing. The beat replaces hope with structure:
//   · ENTITIES — named things with a claims HISTORY (first seen, last seen,
//     what was said about them and when), not a snapshot;
//   · SEEN — dedup keys that make "no repeats across days" checkable: the
//     `remember` tool ANSWERS with which keys are already known, and the
//     recorded trace shows the dedup hit;
//   · SOURCES — per-source yield/dry-streak/failure stats, so the worker
//     knows which wells are dry before drawing;
//   · REFLECTIONS — one short note per check, the worker's own voice,
//     rendered into the NEXT check's context.
// All of it lives in the EXISTING lab_harness_memory rows under reserved
// `beat:*` keys — written through the same transactional `_memoryWrites`
// convention every memory write already uses (recorded in the step, applied
// with it, editable and deletable on the memory surface; no new storage).
// `remember` is a CORE tool (thinking, not acting — no grant, no pore) and
// is gated on spec.memory.beat so pre-P3 prompts stay byte-identical and
// old records replay clean.
import type { LabTool } from './loop.js';

export const BEAT_TOOL_NAME = 'remember';

export const BEAT_LIMITS = {
  MAX_ENTITIES: 200,
  MAX_CLAIMS_PER_ENTITY: 12,
  MAX_SEEN: 600,
  MAX_SOURCES: 60,
  MAX_REFLECTIONS: 10,
  MAX_NAME_CHARS: 120,
  MAX_CLAIM_CHARS: 300,
  MAX_KEY_CHARS: 160,
  MAX_NOTE_CHARS: 500,
  /** Caps one call's batch sizes so a single step can't flood the set. */
  MAX_BATCH: 50,
} as const;

export interface BeatEntity {
  first: string; // YYYY-MM-DD
  last: string;
  claims: Array<{ on: string; text: string }>;
}

export interface BeatSource {
  checks: number;
  items: number;
  lastOn: string;
  dryStreak: number;
  failures: number;
}

export interface BeatState {
  entities: Record<string, BeatEntity>;
  seen: Record<string, string>; // dedupKey -> YYYY-MM-DD first seen
  sources: Record<string, BeatSource>;
  reflections: Array<{ on: string; note: string }>;
}

export const BEAT_KEYS = {
  entities: 'beat:entities',
  seen: 'beat:seen',
  sources: 'beat:sources',
  reflections: 'beat:reflections',
} as const;

export function emptyBeat(): BeatState {
  return { entities: {}, seen: {}, sources: {}, reflections: [] };
}

/** Read the beat out of a raw memory snapshot, defensively — memory rows
 * are operator-editable, and a hand-mangled value must degrade to empty,
 * never crash a run. */
export function beatFromMemory(memory: Record<string, unknown>): BeatState {
  const out = emptyBeat();
  const ent = memory[BEAT_KEYS.entities];
  if (ent !== null && typeof ent === 'object' && !Array.isArray(ent)) {
    for (const [name, v] of Object.entries(ent as Record<string, unknown>)) {
      const e = v as { first?: unknown; last?: unknown; claims?: unknown };
      if (typeof e?.first !== 'string' || typeof e.last !== 'string') continue;
      const claims = Array.isArray(e.claims)
        ? (e.claims as Array<{ on?: unknown; text?: unknown }>)
            .filter((c) => typeof c?.on === 'string' && typeof c?.text === 'string')
            .map((c) => ({ on: c.on as string, text: c.text as string }))
        : [];
      out.entities[name] = { first: e.first, last: e.last, claims };
    }
  }
  const seen = memory[BEAT_KEYS.seen];
  if (seen !== null && typeof seen === 'object' && !Array.isArray(seen)) {
    for (const [k, v] of Object.entries(seen as Record<string, unknown>)) {
      if (typeof v === 'string') out.seen[k] = v;
    }
  }
  const sources = memory[BEAT_KEYS.sources];
  if (sources !== null && typeof sources === 'object' && !Array.isArray(sources)) {
    for (const [name, v] of Object.entries(sources as Record<string, unknown>)) {
      const s = v as { checks?: unknown; items?: unknown; lastOn?: unknown; dryStreak?: unknown; failures?: unknown };
      if (typeof s?.checks !== 'number' || typeof s?.lastOn !== 'string') continue;
      out.sources[name] = {
        checks: s.checks,
        items: typeof s.items === 'number' ? s.items : 0,
        lastOn: s.lastOn,
        dryStreak: typeof s.dryStreak === 'number' ? s.dryStreak : 0,
        failures: typeof s.failures === 'number' ? s.failures : 0,
      };
    }
  }
  const refl = memory[BEAT_KEYS.reflections];
  if (Array.isArray(refl)) {
    out.reflections = (refl as Array<{ on?: unknown; note?: unknown }>)
      .filter((r) => typeof r?.on === 'string' && typeof r?.note === 'string')
      .map((r) => ({ on: r.on as string, note: r.note as string }));
  }
  return out;
}

/** Verbatim-string hygiene (the plan.ts precedent): control characters
 * collapse to spaces, never crash and never pass through. */
function clean(text: string, cap: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, cap);
}

export interface BeatInput {
  entities: Array<{ name: string; claim?: string }>;
  seen: string[];
  sources: Array<{ name: string; outcome: 'items' | 'dry' | 'failed'; items?: number }>;
  reflection?: string;
}

export type ValidatedBeat = { ok: true; input: BeatInput } | { ok: false; reason: string };

export function validateBeat(raw: unknown): ValidatedBeat {
  const r = (raw ?? {}) as {
    entities?: unknown;
    seen?: unknown;
    sources?: unknown;
    reflection?: unknown;
  };
  const input: BeatInput = { entities: [], seen: [], sources: [] };
  if (r.entities !== undefined) {
    if (!Array.isArray(r.entities)) return { ok: false, reason: 'entities must be an array' };
    if (r.entities.length > BEAT_LIMITS.MAX_BATCH) return { ok: false, reason: `at most ${BEAT_LIMITS.MAX_BATCH} entities per call` };
    for (const e of r.entities as Array<{ name?: unknown; claim?: unknown }>) {
      if (typeof e?.name !== 'string' || e.name.trim() === '') return { ok: false, reason: 'every entity needs a name' };
      const claim = typeof e.claim === 'string' && e.claim.trim() !== '' ? clean(e.claim, BEAT_LIMITS.MAX_CLAIM_CHARS) : undefined;
      input.entities.push({ name: clean(e.name, BEAT_LIMITS.MAX_NAME_CHARS), ...(claim !== undefined ? { claim } : {}) });
    }
  }
  if (r.seen !== undefined) {
    if (!Array.isArray(r.seen)) return { ok: false, reason: 'seen must be an array of dedup keys' };
    if (r.seen.length > BEAT_LIMITS.MAX_BATCH) return { ok: false, reason: `at most ${BEAT_LIMITS.MAX_BATCH} seen keys per call` };
    for (const k of r.seen as unknown[]) {
      if (typeof k !== 'string' || k.trim() === '') return { ok: false, reason: 'seen keys must be non-empty strings' };
      input.seen.push(clean(k, BEAT_LIMITS.MAX_KEY_CHARS));
    }
  }
  if (r.sources !== undefined) {
    if (!Array.isArray(r.sources)) return { ok: false, reason: 'sources must be an array' };
    if (r.sources.length > BEAT_LIMITS.MAX_BATCH) return { ok: false, reason: `at most ${BEAT_LIMITS.MAX_BATCH} sources per call` };
    for (const s of r.sources as Array<{ name?: unknown; outcome?: unknown; items?: unknown }>) {
      if (typeof s?.name !== 'string' || s.name.trim() === '') return { ok: false, reason: 'every source needs a name' };
      if (s.outcome !== 'items' && s.outcome !== 'dry' && s.outcome !== 'failed') {
        return { ok: false, reason: "source outcome must be items|dry|failed" };
      }
      const items = typeof s.items === 'number' && Number.isFinite(s.items) && s.items >= 0 ? Math.floor(s.items) : undefined;
      input.sources.push({ name: clean(s.name, BEAT_LIMITS.MAX_NAME_CHARS), outcome: s.outcome, ...(items !== undefined ? { items } : {}) });
    }
  }
  if (r.reflection !== undefined) {
    if (typeof r.reflection !== 'string' || r.reflection.trim() === '') return { ok: false, reason: 'reflection must be a non-empty string' };
    input.reflection = clean(r.reflection, BEAT_LIMITS.MAX_NOTE_CHARS);
  }
  if (input.entities.length === 0 && input.seen.length === 0 && input.sources.length === 0 && input.reflection === undefined) {
    return { ok: false, reason: 'nothing to remember — pass entities, seen, sources, or a reflection' };
  }
  return { ok: true, input };
}

export interface BeatApplied {
  next: BeatState;
  /** Seen keys that were ALREADY known — the dedup hit, with the day each
   * was first seen. This is the answer that makes "report it once" real. */
  duplicates: Array<{ key: string; firstSeen: string }>;
  newKeys: string[];
}

/** Pure merge of one remember-call into the beat. Deterministic given
 * (state, input, today); caps evict oldest-first, ties broken by key so
 * two runs of the same merge agree byte-for-byte. */
export function applyBeat(state: BeatState, input: BeatInput, today: string): BeatApplied {
  const next: BeatState = {
    entities: { ...state.entities },
    seen: { ...state.seen },
    sources: { ...state.sources },
    reflections: [...state.reflections],
  };
  const duplicates: BeatApplied['duplicates'] = [];
  const newKeys: string[] = [];

  for (const k of input.seen) {
    const prior = next.seen[k];
    if (prior !== undefined) {
      duplicates.push({ key: k, firstSeen: prior });
    } else {
      next.seen[k] = today;
      newKeys.push(k);
    }
  }
  // Evict oldest seen keys past the cap (date asc, then key asc — total order).
  const seenEntries = Object.entries(next.seen);
  if (seenEntries.length > BEAT_LIMITS.MAX_SEEN) {
    seenEntries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));
    next.seen = Object.fromEntries(seenEntries.slice(seenEntries.length - BEAT_LIMITS.MAX_SEEN));
  }

  for (const e of input.entities) {
    const prior = next.entities[e.name];
    const claims = prior !== undefined ? [...prior.claims] : [];
    if (e.claim !== undefined) {
      // The same claim on the same day is one claim, not a chorus.
      if (!claims.some((c) => c.on === today && c.text === e.claim)) {
        claims.push({ on: today, text: e.claim });
      }
      while (claims.length > BEAT_LIMITS.MAX_CLAIMS_PER_ENTITY) claims.shift();
    }
    next.entities[e.name] = { first: prior?.first ?? today, last: today, claims };
  }
  const entityEntries = Object.entries(next.entities);
  if (entityEntries.length > BEAT_LIMITS.MAX_ENTITIES) {
    entityEntries.sort((a, b) => (a[1].last < b[1].last ? -1 : a[1].last > b[1].last ? 1 : a[0] < b[0] ? -1 : 1));
    next.entities = Object.fromEntries(entityEntries.slice(entityEntries.length - BEAT_LIMITS.MAX_ENTITIES));
  }

  for (const s of input.sources) {
    const prior = next.sources[s.name] ?? { checks: 0, items: 0, lastOn: today, dryStreak: 0, failures: 0 };
    const got = s.outcome === 'items' ? (s.items ?? 1) : 0;
    next.sources[s.name] = {
      checks: prior.checks + 1,
      items: prior.items + got,
      lastOn: today,
      dryStreak: s.outcome === 'items' ? 0 : prior.dryStreak + 1,
      failures: prior.failures + (s.outcome === 'failed' ? 1 : 0),
    };
  }
  const sourceEntries = Object.entries(next.sources);
  if (sourceEntries.length > BEAT_LIMITS.MAX_SOURCES) {
    sourceEntries.sort((a, b) => (a[1].lastOn < b[1].lastOn ? -1 : a[1].lastOn > b[1].lastOn ? 1 : a[0] < b[0] ? -1 : 1));
    next.sources = Object.fromEntries(sourceEntries.slice(sourceEntries.length - BEAT_LIMITS.MAX_SOURCES));
  }

  if (input.reflection !== undefined) {
    next.reflections.push({ on: today, note: input.reflection });
    while (next.reflections.length > BEAT_LIMITS.MAX_REFLECTIONS) next.reflections.shift();
  }

  return { next, duplicates, newKeys };
}

export function beatToMemoryWrites(state: BeatState): Record<string, unknown> {
  return {
    [BEAT_KEYS.entities]: state.entities,
    [BEAT_KEYS.seen]: state.seen,
    [BEAT_KEYS.sources]: state.sources,
    [BEAT_KEYS.reflections]: state.reflections,
  };
}

/** The prompt's rendering of the beat — the worker's working set, readable.
 * Deterministic given the memory snapshot (keys sorted; recency windows
 * fixed). Empty beat renders nothing. */
export function renderBeatLedger(memory: Record<string, unknown>): string {
  const beat = beatFromMemory(memory);
  const parts: string[] = [];
  const entityNames = Object.keys(beat.entities).sort();
  if (entityNames.length > 0) {
    // The 20 most recently touched entities ride the prompt; the store
    // holds more. Recency desc, then name — total order.
    const chosen = entityNames
      .map((n) => [n, beat.entities[n]!] as const)
      .sort((a, b) => (a[1].last > b[1].last ? -1 : a[1].last < b[1].last ? 1 : a[0] < b[0] ? -1 : 1))
      .slice(0, 20);
    const lines = chosen.map(([name, e]) => {
      const latest = e.claims.length > 0 ? ` — latest: ${e.claims[e.claims.length - 1]!.text}` : '';
      return `- ${name} (first ${e.first}, last ${e.last}, ${e.claims.length} claim${e.claims.length === 1 ? '' : 's'})${latest}`;
    });
    parts.push(`Known entities (${entityNames.length}):\n${lines.join('\n')}`);
  }
  const sourceNames = Object.keys(beat.sources).sort();
  if (sourceNames.length > 0) {
    const lines = sourceNames.map((n) => {
      const s = beat.sources[n]!;
      const dry = s.dryStreak > 0 ? `, dry ${s.dryStreak} check${s.dryStreak === 1 ? '' : 's'} running` : '';
      const fail = s.failures > 0 ? `, ${s.failures} failure${s.failures === 1 ? '' : 's'}` : '';
      return `- ${n}: ${s.items} item${s.items === 1 ? '' : 's'} over ${s.checks} check${s.checks === 1 ? '' : 's'}${dry}${fail} (last ${s.lastOn})`;
    });
    parts.push(`Source record:\n${lines.join('\n')}`);
  }
  const seenCount = Object.keys(beat.seen).length;
  if (seenCount > 0) {
    parts.push(`Already reported: ${seenCount} item${seenCount === 1 ? '' : 's'} on file — check candidates with ${BEAT_TOOL_NAME} before reporting.`);
  }
  if (beat.reflections.length > 0) {
    const recent = beat.reflections.slice(-3);
    parts.push(`Your notes from recent checks:\n${recent.map((r) => `- [${r.on}] ${r.note}`).join('\n')}`);
  }
  return parts.join('\n');
}

/** The beat law — rides the system prompt of beat-bearing specs only. */
export const BEAT_PROMPT = [
  `You keep a durable working set with the ${BEAT_TOOL_NAME} tool (it survives across checks):`,
  `- BEFORE reporting items, pass their dedup keys via {seen: [...]}: keys already on file are old news — never report them again; the tool answers with which are duplicates.`,
  `- Record what you learned: {entities: [{name, claim}]} for named things worth tracking, {sources: [{name, outcome: items|dry|failed, items}]} for every source you checked.`,
  `- Before finishing, file one short {reflection} — what worked, what was dry — it is shown to you next check.`,
].join('\n');

export interface BeatToolDeps {
  /** Current beat state — the loop seeds it from the leg's memory read and
   * this tool's own applied writes accumulate into it within the leg. */
  state: { current: BeatState };
  /** YYYY-MM-DD from the loop's clock — never a direct Date.now(). */
  today: () => string;
}

export function buildBeatTool(deps: BeatToolDeps): LabTool {
  return {
    name: BEAT_TOOL_NAME,
    description:
      'Your durable working set across checks. Pass any of: seen (dedup keys — the answer names which are already on file, so you never report an item twice), ' +
      'entities ([{name, claim?}] — named things with a claims history), sources ([{name, outcome: items|dry|failed, items?}] — what each source yielded), ' +
      'reflection (one short note for your next check).',
    parameters: {
      type: 'object',
      properties: {
        seen: { type: 'array', items: { type: 'string' }, description: 'Dedup keys for candidate items (stable slugs, e.g. a normalized URL or headline).' },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The entity, canonical name.' },
              claim: { type: 'string', description: 'One dated claim about it (optional).' },
            },
            required: ['name'],
          },
        },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              outcome: { type: 'string', enum: ['items', 'dry', 'failed'] },
              items: { type: 'number', description: 'How many items it yielded (outcome items).' },
            },
            required: ['name', 'outcome'],
          },
        },
        reflection: { type: 'string', description: 'One short note for your next check.' },
      },
    },
    external: false,
    core: true,
    run: async (input: unknown): Promise<unknown> => {
      const v = validateBeat(input);
      if (!v.ok) return { error: v.reason };
      const applied = applyBeat(deps.state.current, v.input, deps.today());
      deps.state.current = applied.next;
      return {
        ok: true,
        duplicates: applied.duplicates,
        newKeys: applied.newKeys.length,
        entities: Object.keys(applied.next.entities).length,
        _memoryWrites: beatToMemoryWrites(applied.next),
      };
    },
  };
}
