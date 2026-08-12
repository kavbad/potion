// llm.call span emission per the A3-verified ingest shape (traces.ts:49-63):
// trace_id = the runId, one span per model step, idempotent on
// (org, trace, span) so re-emission after a crash is safe. This is the
// adapter A3 predicted — Lab code, zero converter changes.
import type { LabRunStepRow } from '@potion/db';
import type { StepPayload } from './checkpoint.js';

export function spansForSteps(runId: string, steps: LabRunStepRow[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const step of steps) {
    if (step.kind !== 'model') continue;
    const p = step.payload as StepPayload;
    out.push({
      trace_id: runId,
      span_id: `${runId}-s${step.seq}`,
      name: 'llm.call',
      ...(p.usage !== undefined
        ? { input_tokens: p.usage.promptTokens, output_tokens: p.usage.completionTokens }
        : {}),
      attributes: {
        'gen_ai.operation.name': 'llm_call',
        'potion.lab.seq': step.seq,
        ...(p.completionId !== undefined ? { 'potion.completion_id': p.completionId } : {}),
        ...(p.frontierTrace !== undefined ? { 'potion.frontier_trace': p.frontierTrace } : {}),
      },
      ts: new Date(p.clockMs).toISOString(),
    });
  }
  return out;
}
