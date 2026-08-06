// HumanEval ingest adapter (ROADMAP M1a): converts HumanEval-format JSONL
//   {task_id, prompt, canonical_solution, test, entry_point}
// into code-gen EvalItems.
//
// LANGUAGE NOTE (documented): HumanEval is Python; our code-exec scorer
// (scorers.ts) runs JavaScript only in a node:vm sandbox. This adapter emits
//   scoring {kind:'code-exec', language:'javascript'} ONLY for tasks with a
//   faithful hand-transpilation supplied via `transpilations[task_id]`
//   ({entryPoint, solution, tests} — JS function name, canonical JS solution,
//   and a scorer-contract test snippet). Every other task is emitted as
//   language:'python' with the Python reference/tests preserved; the runner
//   SKIPS python items with a clear warning (python-exec scorer is a
//   documented TODO — intentionally not built here).
import { z } from 'zod';
import type { ClusterId, EvalItem } from '@potion/core';

export const HumanEvalTaskSchema = z.object({
  task_id: z.string().min(1),
  prompt: z.string(),
  canonical_solution: z.string(),
  test: z.string(),
  entry_point: z.string().min(1),
});

export type HumanEvalTask = z.infer<typeof HumanEvalTaskSchema>;

/** A faithful JS transpilation of one HumanEval task. `solution` must define
 * `entryPoint` (JS name); `tests` uses the scorer contract: test(name, fn)
 * with assert(cond)/assertDeepEqual(a, b). */
export const JsTranspilationSchema = z.object({
  entryPoint: z.string().min(1),
  solution: z.string().min(1),
  tests: z.string().min(1),
});

export type JsTranspilation = z.infer<typeof JsTranspilationSchema>;

export const JsTranspilationMapSchema = z.record(JsTranspilationSchema);

export interface HumanEvalConvertOptions {
  clusterId?: ClusterId | undefined;
  /** Prepended to every sanitized task_id to form the EvalItem id. */
  idPrefix?: string | undefined;
  transpilations?: Record<string, JsTranspilation> | undefined;
}

export interface HumanEvalConvertResult {
  items: EvalItem[];
  /** One entry per non-transpiled task (emitted as python, skipped at run). */
  warnings: string[];
}

/** task_id ('HumanEval/12', 'JS-Bench/03') → stable item-id slug. */
export function sanitizeTaskId(taskId: string): string {
  return taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Extract the human-readable task description from a HumanEval python prompt:
 * the docstring body, truncated before the first doctest (`>>>`) line. */
export function descriptionFromPrompt(prompt: string): string {
  const m = /"""\s*([\s\S]*?)"""/.exec(prompt);
  if (!m) return prompt.trim().split('\n')[0] ?? '';
  const lines = (m[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const desc: string[] = [];
  for (const line of lines) {
    if (line.startsWith('>>>')) break;
    desc.push(line);
  }
  return desc.join(' ').trim();
}

export function parseHumanEvalJsonl(text: string): HumanEvalTask[] {
  const tasks: HumanEvalTask[] = [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new Error(`humaneval input line ${i + 1}: invalid JSON — ${(e as Error).message}`);
    }
    const parsed = HumanEvalTaskSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`humaneval input line ${i + 1}: invalid task — ${parsed.error.message}`);
    }
    tasks.push(parsed.data);
  });
  return tasks;
}

const JS_REPLY_SUFFIX = 'Respond with ONLY the JavaScript function source, no markdown fences, no explanation.';
const PY_REPLY_SUFFIX = 'Respond with ONLY the Python function source, no markdown fences, no explanation.';

/** Pure conversion: HumanEval JSONL text → code-gen EvalItems. */
export function convertHumanEval(
  text: string,
  opts: HumanEvalConvertOptions = {},
): HumanEvalConvertResult {
  const clusterId = opts.clusterId ?? 'code-gen';
  const idPrefix = opts.idPrefix ?? '';
  const tasks = parseHumanEvalJsonl(text);
  const items: EvalItem[] = [];
  const warnings: string[] = [];

  for (const task of tasks) {
    const id = `${idPrefix}${sanitizeTaskId(task.task_id)}`;
    const description = descriptionFromPrompt(task.prompt);
    const js = opts.transpilations?.[task.task_id];
    if (js) {
      items.push({
        id,
        clusterId,
        prompt: [
          {
            role: 'user',
            content: `EVAL: ${id}\nImplement \`${js.entryPoint}\`: ${description}\n\n${JS_REPLY_SUFFIX}`,
          },
        ],
        reference: js.solution,
        scoring: { kind: 'code-exec', language: 'javascript', tests: js.tests },
      });
    } else {
      items.push({
        id,
        clusterId,
        prompt: [
          {
            role: 'user',
            content: `EVAL: ${id}\nImplement \`${task.entry_point}\`: ${description}\n\n${PY_REPLY_SUFFIX}`,
          },
        ],
        reference: task.canonical_solution,
        scoring: { kind: 'code-exec', language: 'python', tests: task.test },
      });
      warnings.push(
        `task '${task.task_id}' ('${id}'): no faithful JS transpilation supplied — emitted as language 'python'; the runner will SKIP it (python-exec scorer TODO)`,
      );
    }
  }
  return { items, warnings };
}
