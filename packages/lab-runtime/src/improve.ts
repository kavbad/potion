// W3 — the improve engine (WORKERS-DIRECTION, 2026-09-01). Corrections are
// defect reports; interventions are evidence. This module turns the durable
// record into TYPED improvement proposals, and proposals into DESCENDANT
// specs — never an in-place edit (a generation never changes; learning
// reproduces).
//
// v1 detectors are scoped to signals REAL runs produce today (A5):
//   · a question the worker keeps asking (worker-question check-ins with
//     similar text across runs) — the mission is missing information the
//     operator keeps supplying; fold the ANSWER into the worker.
//   · an action class the operator keeps refusing — the constitution
//     should say ask-forever instead of making the human refuse forever.
//
// Every proposal carries the §60 fields: noticed / change / why — and its
// evidence is countable from the record (A1).
import type { HarnessSpec } from '@potion/lab-spec';
import type { StepPayload } from './checkpoint.js';

export interface ImprovementProposal {
  /** Stable id derived from content — same record, same id. */
  id: string;
  mutation: {
    type: 'instruction' | 'constitution';
    summary: string;
    noticed: string;
    why: string;
    change: Record<string, unknown>;
  };
  /** How many observations back this proposal. */
  evidenceN: number;
}

export interface ImproveStep {
  runId: string;
  payload: StepPayload;
  createdAt: Date;
}

const QUESTION_CLUSTER_MIN = 2;
const REFUSAL_CLUSTER_MIN = 2;

function normalizeQuestion(q: string): string {
  // Cluster key: the first five content words, urls/numbers collapsed,
  // punctuation stripped — recurring questions from the same worker are
  // near-identical, not byte-identical ("What URL should I open?" vs
  // "What URL should I open today?").
  return q
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9]+/g, '<n>')
    .replace(/[^a-z<>\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)
    .join(' ');
}

function slug(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function deriveImprovements(spec: HarnessSpec, steps: ImproveStep[]): ImprovementProposal[] {
  const out: ImprovementProposal[] = [];

  // ── detector 1: the recurring worker question ──
  // Cluster worker-question check-ins by normalized text; a cluster that
  // spans ≥2 RUNS means the mission is missing information. The proposal
  // folds the operator's most recent ANSWER in as a standing rule.
  const questions = new Map<string, { runs: Set<string>; q: string; answers: string[] }>();
  let lastQuestionKey: string | null = null;
  for (const s of steps) {
    const p = s.payload;
    if (p.kind === 'check-in' && p.checkInTrigger === 'worker-question' && p.checkInQuestion !== undefined) {
      const key = normalizeQuestion(p.checkInQuestion);
      const entry = questions.get(key) ?? { runs: new Set<string>(), q: p.checkInQuestion, answers: [] };
      entry.runs.add(s.runId);
      questions.set(key, entry);
      lastQuestionKey = key;
      continue;
    }
    if (p.checkInAnswer !== undefined && lastQuestionKey !== null) {
      questions.get(lastQuestionKey)?.answers.push(p.checkInAnswer);
      lastQuestionKey = null;
    }
  }
  for (const [key, c] of questions) {
    if (c.runs.size < QUESTION_CLUSTER_MIN || c.answers.length === 0) continue;
    const answer = c.answers[c.answers.length - 1]!;
    const rule = `Standing answer from the operator (do not ask again): Q: ${c.q.slice(0, 200)} A: ${answer.slice(0, 300)}`;
    out.push({
      id: `imp-${slug(`q:${key}`)}`,
      mutation: {
        type: 'instruction',
        summary: 'fold a recurring answer into the worker',
        noticed: `it asked the same question in ${c.runs.size} separate runs: “${c.q.slice(0, 120)}”`,
        why: 'a question the operator answers every run is information the mission is missing — carrying the answer removes a round-trip from every future run',
        change: { appendRule: rule },
      },
      evidenceN: c.runs.size,
    });
  }

  // ── detector 2: the repeatedly-refused action class ──
  const refusals = new Map<string, { rejected: number; approved: number }>();
  let pendingClass: string | null = null;
  for (const s of steps) {
    const p = s.payload;
    if (p.kind === 'check-in' && p.checkInTrigger === 'before-external-action' && p.checkInAction) {
      pendingClass = p.checkInAction.toolName;
      continue;
    }
    if (p.checkInAnswer !== undefined && pendingClass !== null) {
      const entry = refusals.get(pendingClass) ?? { rejected: 0, approved: 0 };
      const affirmative = /^\s*(y|yes|ok|sure|approve|go|proceed)/i.test(p.checkInAnswer);
      if (affirmative) entry.approved += 1;
      else entry.rejected += 1;
      refusals.set(pendingClass, entry);
      pendingClass = null;
    }
  }
  for (const [cls, r] of refusals) {
    if (r.rejected < REFUSAL_CLUSTER_MIN || r.approved > 0) continue;
    const already = spec.constitution?.find((c) => c.action === cls)?.maxAuthority;
    if (already === 'ask-forever' || already === 'barred') continue;
    out.push({
      id: `imp-${slug(`c:${cls}`)}`,
      mutation: {
        type: 'constitution',
        summary: `pin ${cls} to ask-forever`,
        noticed: `you refused ${cls} ${r.rejected} time(s) and never approved it`,
        why: 'a class the operator always refuses should never be proposable for autonomy — the constitution should say so instead of making a human say no forever',
        change: { action: cls, maxAuthority: 'ask-forever' },
      },
      evidenceN: r.rejected,
    });
  }

  return out;
}

/** Apply a typed mutation to the parent spec — a NEW spec, the parent
 * untouched. The caller hashes it; the hash difference IS the generation
 * boundary. Throws on a change the type cannot express. */
export function buildDescendantSpec(parent: HarnessSpec, mutation: ImprovementProposal['mutation']): HarnessSpec {
  if (mutation.type === 'instruction') {
    const rule = mutation.change.appendRule;
    if (typeof rule !== 'string' || rule.trim() === '') throw new Error('instruction mutation needs change.appendRule');
    return { ...parent, rules: [...parent.rules, rule.trim()].slice(0, 100) };
  }
  const action = mutation.change.action;
  const maxAuthority = mutation.change.maxAuthority;
  if (typeof action !== 'string' || (maxAuthority !== 'earnable' && maxAuthority !== 'ask-forever' && maxAuthority !== 'barred')) {
    throw new Error('constitution mutation needs change.action and a valid change.maxAuthority');
  }
  const rest = (parent.constitution ?? []).filter((c) => c.action !== action);
  return { ...parent, constitution: [...rest, { action, maxAuthority }] };
}

/** W3 — selective trust inheritance v1, at spec-section granularity (the
 * IR gives node granularity later — WORKERS-DIRECTION amendment). The rule:
 *   constitution mutation → every class keeps its earned state except the
 *     changed class (its new ceiling governs it anyway);
 *   instruction mutation → the worker's BEHAVIOR changed: act classes
 *     re-prove (supervised, reason says why); read classes keep their
 *     state (reading was demonstrated mechanics, not judgment).
 * Preserved grants keep situations + grantedAt — and the W2 law (known
 * evidence never re-indicts, no failure → no tighten) protects inherited
 * autonomy from being revoked for thin evidence on the new hash. */
export function inheritGrantPlan(
  mutation: ImprovementProposal['mutation'],
  grants: Array<{ actionClass: string; state: string; riskTier: string }>,
): Array<{ actionClass: string; preserve: boolean; why: string }> {
  return grants.map((g) => {
    if (mutation.type === 'constitution') {
      const changed = mutation.change.action === g.actionClass;
      return {
        actionClass: g.actionClass,
        preserve: !changed,
        why: changed
          ? 'this class is what the mutation changed — its new ceiling governs'
          : 'unchanged by the mutation — earned state carries to the new generation',
      };
    }
    const isRead = g.riskTier === 'reversible-read';
    return {
      actionClass: g.actionClass,
      preserve: isRead,
      why: isRead
        ? 'read-class mechanics unchanged by instructions — earned state carries'
        : 'instructions changed how this worker acts — act classes re-prove under the new generation',
    };
  });
}

/** W3 — shadow stubs: the candidate rehearses against the PARENT's recorded
 * act outputs. Only external (act) tools are stubbed — reads are
 * side-effect-free by the X6 law and stay real, so the rehearsal sees the
 * live world but cannot touch it. Outputs replay per tool name in recorded
 * order; an exhausted queue returns a typed note, never an invented result. */
export function buildShadowStub(
  original: { name: string; description: string; parameters: Record<string, unknown> },
  recorded: unknown[],
): { name: string; description: string; parameters: Record<string, unknown>; external: false; core?: boolean; run: (input: unknown) => Promise<unknown> } {
  const queue = [...recorded];
  return {
    name: original.name,
    description: original.description,
    parameters: original.parameters,
    external: false,
    run: async () => {
      const next = queue.shift();
      if (next !== undefined) return next;
      return {
        shadowStub: true,
        note: 'shadow rehearsal: no recorded output remains for this act — the real generation would have acted here',
      };
    },
  };
}

/** Recorded act outputs per tool name, in order, from a parent run's steps. */
export function recordedActOutputs(
  steps: Array<{ kind: string; payload: { toolName?: string; toolOutput?: unknown; gate?: unknown } }>,
): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const s of steps) {
    if (s.kind !== 'tool' || s.payload.toolName === undefined) continue;
    const list = out.get(s.payload.toolName) ?? [];
    list.push(s.payload.toolOutput ?? null);
    out.set(s.payload.toolName, list);
  }
  return out;
}
