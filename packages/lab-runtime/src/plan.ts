// X2 (2026-08-28) — THE DURABLE TASK LEDGER. What actually loses a long
// mission's thread is leg amnesia: a resumed leg rebuilds context from the
// LAST recorded exchange only. The ledger fixes it lawfully:
//   · `update_plan` is a CORE loop tool — always available, no grant (a
//     plan is thinking, not acting on the world);
//   · every update REPLACES the whole ledger (full-state writes — no merge
//     logic to diverge between loop and replay);
//   · the current ledger is DERIVED from the recorded steps (last valid
//     update wins) — no new storage, nothing the checkpoint record does
//     not already carry;
//   · at every leg boundary the derived ledger is re-injected as one
//     recorded message, stamped on the leg's first step exactly like a
//     check-in answer, so replay re-derives the same conversation.
import type { LabTool } from './loop.js';

export const PLAN_TOOL_NAME = 'update_plan';

export const PLAN_LIMITS = {
  MAX_TASKS: 30,
  MAX_TITLE_CHARS: 200,
  MAX_NOTE_CHARS: 300,
  MAX_ID_CHARS: 40,
} as const;

export type PlanStatus = 'pending' | 'doing' | 'done' | 'blocked';
const STATUSES: ReadonlySet<string> = new Set(['pending', 'doing', 'done', 'blocked']);

export interface PlanTask {
  id: string;
  title: string;
  status: PlanStatus;
  note?: string;
}

/** Verbatim-string hygiene, matching the spec layer: control characters
 * collapse to spaces, never crash and never pass through. */
function clean(text: string, cap: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, cap);
}

export type ValidatedPlan = { ok: true; tasks: PlanTask[] } | { ok: false; reason: string };

export function validatePlan(input: unknown): ValidatedPlan {
  const tasks = (input as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return { ok: false, reason: 'tasks (an array) is required' };
  if (tasks.length === 0) return { ok: false, reason: 'a plan needs at least one task' };
  if (tasks.length > PLAN_LIMITS.MAX_TASKS) {
    return { ok: false, reason: `at most ${PLAN_LIMITS.MAX_TASKS} tasks — collapse the small ones` };
  }
  const out: PlanTask[] = [];
  const seen = new Set<string>();
  for (const raw of tasks) {
    const t = raw as { id?: unknown; title?: unknown; status?: unknown; note?: unknown };
    if (typeof t.id !== 'string' || t.id.trim() === '' || t.id.length > PLAN_LIMITS.MAX_ID_CHARS) {
      return { ok: false, reason: `every task needs an id (≤${PLAN_LIMITS.MAX_ID_CHARS} chars)` };
    }
    if (seen.has(t.id)) return { ok: false, reason: `duplicate task id '${t.id}'` };
    seen.add(t.id);
    if (typeof t.title !== 'string' || t.title.trim() === '') {
      return { ok: false, reason: `task '${t.id}' needs a title` };
    }
    if (typeof t.status !== 'string' || !STATUSES.has(t.status)) {
      return { ok: false, reason: `task '${t.id}' status must be pending|doing|done|blocked` };
    }
    const note = typeof t.note === 'string' && t.note.trim() !== '' ? clean(t.note, PLAN_LIMITS.MAX_NOTE_CHARS) : undefined;
    out.push({
      id: clean(t.id, PLAN_LIMITS.MAX_ID_CHARS),
      title: clean(t.title, PLAN_LIMITS.MAX_TITLE_CHARS),
      status: t.status as PlanStatus,
      ...(note !== undefined ? { note } : {}),
    });
  }
  return { ok: true, tasks: out };
}

export function renderPlanLedger(tasks: PlanTask[]): string {
  const mark: Record<PlanStatus, string> = { pending: ' ', doing: '~', done: 'x', blocked: '!' };
  return tasks
    .map((t) => `[${mark[t.status]}] ${t.id} · ${t.title}${t.note !== undefined ? ` — ${t.note}` : ''}`)
    .join('\n');
}

/** The exact message a leg-boundary re-injection becomes. Replay derives it
 * from the leg stamp with THIS function — never a re-implementation. */
export function planLedgerMessage(rendered: string): { role: 'user'; content: string } {
  return {
    role: 'user',
    content:
      `Your task ledger (durable — [x] done, [~] doing, [!] blocked, [ ] pending):\n${rendered}\n` +
      `Continue from where the ledger says. Keep it current with ${PLAN_TOOL_NAME}.`,
  };
}

/** Derive the CURRENT ledger from recorded steps: the last update_plan tool
 * step whose recorded input validates. Pure over the record — the loop and
 * replay (and the run page) all read the same truth. */
export function planFromSteps(
  steps: Array<{ kind: string; payload: unknown }>,
): PlanTask[] | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind !== 'tool') continue;
    const p = s.payload as { toolName?: string; toolInput?: unknown };
    if (p.toolName !== PLAN_TOOL_NAME) continue;
    let input: unknown = p.toolInput;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        continue;
      }
    }
    const v = validatePlan(input);
    if (v.ok) return v.tasks;
  }
  return null;
}

export function buildPlanTool(): LabTool {
  return {
    name: PLAN_TOOL_NAME,
    description:
      'Maintain your durable task ledger. Pass the FULL plan every time (it replaces the previous one): ' +
      'tasks: [{id, title, status: pending|doing|done|blocked, note?}]. File a plan before multi-step work; ' +
      'update statuses as you go. The ledger survives interruptions and is re-shown to you when work resumes.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'The complete plan, replacing the previous version.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short stable id, e.g. "1" or "fetch".' },
              title: { type: 'string', description: 'What this task is, in one line.' },
              status: { type: 'string', enum: ['pending', 'doing', 'done', 'blocked'] },
              note: { type: 'string', description: 'Optional short note (e.g. why blocked).' },
            },
            required: ['id', 'title', 'status'],
          },
        },
      },
      required: ['tasks'],
    },
    external: false,
    core: true,
    run: async (input: unknown): Promise<unknown> => {
      const v = validatePlan(input);
      if (!v.ok) return { error: v.reason };
      return { ok: true, taskCount: v.tasks.length, ledger: renderPlanLedger(v.tasks) };
    },
  };
}
