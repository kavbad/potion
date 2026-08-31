// X4 (2026-08-28) — IT MULTIPLIES. Fan-out sub-runs under two laws:
//   · ONE FUEL TREE — every helper's cap is a slice of the parent's
//     REMAINING budget, a reserve is held back so the parent can always
//     synthesize, and each helper enforces its slice with the same
//     hard-stop machinery the parent runs under. By construction the
//     family can never outspend the cap the operator set.
//   · ONE TRACE — each helper is a full lab_runs row (its own recorded
//     steps, its own budget death), linked by parent_run_id; the parent
//     records ONE tool step whose output carries every helper's verdict.
// Helpers THINK, READ (web) and COMPUTE (code) when the parent has those
// powers — they carry no check-ins and no act-classified tools, so they
// can never fire the pore, never park, and never take an external action.
// They also never delegate further (depth 1): a helper's spec carries no
// fanOut. The delegate tool itself is loop-owned machinery (core: no
// grant, no pore — the only thing it spends is fuel the operator already
// capped); the EXECUTOR that actually runs helpers is injected by the
// worker handler, which owns the db and the serving keys.
import type { LabTool } from './loop.js';

export const FANOUT_TOOL_NAME = 'delegate';

export const FANOUT_LIMITS = {
  MAX_TASKS: 5,
  MAX_GOAL_CHARS: 2000,
  MAX_RESULT_CHARS: 4000,
  /** Fraction of the remaining budget held back for the parent's own
   * synthesis after the helpers return. */
  RESERVE_FRACTION: 0.25,
  /** A helper slice below this cannot do real work — refuse the fan-out
   * with a reason instead of spawning starved helpers. */
  MIN_SUB_BUDGET_USD: 0.02,
} as const;

export interface FanOutTask {
  goal: string;
  doneDefinition: string;
}

export type ValidatedFanOut = { ok: true; tasks: FanOutTask[] } | { ok: false; reason: string };

export function validateFanOut(raw: unknown, maxWorkers: number): ValidatedFanOut {
  const tasks = (raw as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, reason: 'tasks (a non-empty array of {goal, doneDefinition}) is required' };
  }
  const cap = Math.min(maxWorkers, FANOUT_LIMITS.MAX_TASKS);
  if (tasks.length > cap) {
    return { ok: false, reason: `at most ${cap} helpers on this worker — merge the smaller tasks` };
  }
  const out: FanOutTask[] = [];
  for (const raw2 of tasks) {
    const t = raw2 as { goal?: unknown; doneDefinition?: unknown };
    if (typeof t.goal !== 'string' || t.goal.trim() === '') {
      return { ok: false, reason: 'every task needs a goal' };
    }
    if (typeof t.doneDefinition !== 'string' || t.doneDefinition.trim() === '') {
      return { ok: false, reason: `task '${t.goal.slice(0, 40)}…' needs a doneDefinition — a helper must know when it is done` };
    }
    out.push({
      goal: t.goal.trim().slice(0, FANOUT_LIMITS.MAX_GOAL_CHARS),
      doneDefinition: t.doneDefinition.trim().slice(0, FANOUT_LIMITS.MAX_GOAL_CHARS),
    });
  }
  return { ok: true, tasks: out };
}

/** The fuel-tree arithmetic, pure and total: given the family cap and what
 * the family has spent, slice budgets for n helpers with the synthesis
 * reserve held back. Refuses (null) when the slices would starve. */
export function allocateFanOut(
  capUsd: number,
  familySpentUsd: number,
  n: number,
): { perSubUsd: number; reserveUsd: number } | null {
  const remaining = capUsd - familySpentUsd;
  if (remaining <= 0) return null;
  const reserveUsd = remaining * FANOUT_LIMITS.RESERVE_FRACTION;
  const perSubUsd = Math.floor(((remaining - reserveUsd) / n) * 10_000) / 10_000;
  if (perSubUsd < FANOUT_LIMITS.MIN_SUB_BUDGET_USD) return null;
  return { perSubUsd, reserveUsd };
}

/** Family spend recorded in the PARENT's own steps: every delegate tool
 * step's helpers[].estUsd. Pure over the record — the loop's fuel gate and
 * replay derive the IDENTICAL number, so "one fuel tree" survives replay. */
export function fanOutSpentFromSteps(steps: Array<{ kind: string; payload: unknown }>): number {
  let total = 0;
  for (const s of steps) {
    if (s.kind !== 'tool') continue;
    const p = s.payload as { toolName?: string; toolOutput?: { helpers?: Array<{ estUsd?: number }> } };
    if (p.toolName !== FANOUT_TOOL_NAME) continue;
    for (const h of p.toolOutput?.helpers ?? []) total += typeof h.estUsd === 'number' ? h.estUsd : 0;
  }
  return total;
}

export interface SubRunResult {
  runId: string;
  goal: string;
  state: 'completed' | 'failed' | 'killed-budget';
  /** The helper's final answer (completed) or its typed reason. Capped. */
  result: string;
  estUsd: number;
}

export interface FanOutDeps {
  maxWorkers: number;
  /** Injected by the worker handler: run ONE helper to a terminal state
   * under the given budget slice and return its verdict. Sequential calls
   * — the executor owns ordering, keys, and the db. */
  runSub: (task: FanOutTask, budgetUsd: number, index: number) => Promise<SubRunResult>;
  /** The family's spend so far (parent steps + prior helpers), read fresh
   * at call time — the allocation is only honest against live numbers. */
  familySpentUsd: () => Promise<number>;
  capUsd: number;
}

export function buildFanOutTool(deps: FanOutDeps): LabTool {
  return {
    name: FANOUT_TOOL_NAME,
    description:
      `Split big work across up to ${Math.min(deps.maxWorkers, FANOUT_LIMITS.MAX_TASKS)} helpers, each a full worker run under its own budget slice taken from YOUR remaining budget (a reserve is kept for your synthesis). ` +
      'Pass tasks: [{goal, doneDefinition}]. Helpers think, read the web, and run code when those powers are enabled — they cannot take external actions and cannot delegate further. ' +
      'They run one after another; each returns its result or a typed failure. Work with what returns and name gaps honestly.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'The subtasks, one helper each.',
          items: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: 'What this helper should do, self-contained.' },
              doneDefinition: { type: 'string', description: 'How the helper knows it is done.' },
            },
            required: ['goal', 'doneDefinition'],
          },
        },
      },
      required: ['tasks'],
    },
    external: false,
    core: true,
    run: async (input: unknown): Promise<unknown> => {
      const v = validateFanOut(input, deps.maxWorkers);
      if (!v.ok) return { error: v.reason };
      const spent = await deps.familySpentUsd();
      const alloc = allocateFanOut(deps.capUsd, spent, v.tasks.length);
      if (alloc === null) {
        return {
          error: `not enough budget to fan out: $${Math.max(deps.capUsd - spent, 0).toFixed(2)} remains of the $${deps.capUsd.toFixed(2)} cap and each helper needs at least $${FANOUT_LIMITS.MIN_SUB_BUDGET_USD.toFixed(2)} after the synthesis reserve — do the work yourself or drop tasks`,
        };
      }
      const results: SubRunResult[] = [];
      for (let i = 0; i < v.tasks.length; i++) {
        results.push(await deps.runSub(v.tasks[i]!, alloc.perSubUsd, i));
      }
      return {
        ok: true,
        helpers: results.map((r) => ({
          runId: r.runId,
          goal: r.goal.slice(0, 200),
          state: r.state,
          result: r.result.slice(0, FANOUT_LIMITS.MAX_RESULT_CHARS),
          estUsd: Math.round(r.estUsd * 10_000) / 10_000,
        })),
        perHelperBudgetUsd: alloc.perSubUsd,
      };
    },
  };
}

/** The helper's spec, derived from the parent's — the depth-1 and
 * never-acts laws live HERE, structurally:
 *   · mission: the subtask, always a task with a done-definition;
 *   · superpowers: parent's ∩ builtins (web/code) — no connector sessions,
 *     no act-classified tools in a helper;
 *   · checkIns: none (nothing to park on — helpers cannot reach the pore);
 *   · fanOut: stripped (a helper never delegates);
 *   · memory: off (helpers must not write the harness's working set);
 *   · fuel: the slice, hard stop.
 * Contract/exemplar are deliberately dropped: the helper's deliverable is
 * its final answer, which the PARENT synthesizes under its own contract. */
export function deriveSubSpec(
  parent: {
    name: string;
    brain: unknown;
    superpowers: Array<{ id: string; scopes: string[] }>;
    rules: string[];
  },
  task: FanOutTask,
  budgetUsd: number,
  index: number,
): Record<string, unknown> {
  return {
    specVersion: 1,
    name: `${parent.name} · helper ${index + 1}`,
    brain: parent.brain,
    mission: { kind: 'task', goal: task.goal, doneDefinition: task.doneDefinition },
    superpowers: parent.superpowers.filter((s) => s.id === 'web' || s.id === 'code'),
    memory: { enabled: false },
    rules: parent.rules,
    fuel: { maxUsdPerRun: budgetUsd, hardStop: true },
    checkIns: [],
  };
}
