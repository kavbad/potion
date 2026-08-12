// llm.call span emission per the A3-verified ingest shape — ENRICHED in
// Step 4 so a run's steps can land as eval items through the EXISTING
// step-synthesis path with zero converter changes.
//
// The measured gap this closes: the synthesis read model consumes
// `gen_ai.prompt` (user turns), `gen_ai.completion` (assistant steps),
// `tool.args`/`tool.result` on `tool.*` spans, and SKIPS any llm.call span
// with no completion (packages/db/src/repos/traces.ts:282-297). Step 3's
// spans carried tokens and completionId only — cost attribution, zero
// synthesizable content. The content comes from CHECKPOINTS, which already
// passed the secret gate; server-side ingest redaction (G1.1) still applies
// on top, unchanged.
import type { LabRunStepRow } from '@potion/db';
import type { ChatMessage } from '@potion/core';
import type { StepPayload } from './checkpoint.js';

/**
 * Content cap per attribute. Truncation WITHOUT a marker would silently
 * break the "context the call saw" promise, so the marker is part of the
 * contract — a consumer can always tell a short context from a cut one.
 */
export const SPAN_CONTENT_MAX_CHARS = 8_000;
export const SPAN_TRUNCATION_MARKER = '…[truncated by lab-runtime]';

export function capContent(text: string): string {
  if (text.length <= SPAN_CONTENT_MAX_CHARS) return text;
  return text.slice(0, SPAN_CONTENT_MAX_CHARS - SPAN_TRUNCATION_MARKER.length) + SPAN_TRUNCATION_MARKER;
}

/** The last user-visible turn in a request — what the synthesis read model
 * treats as the user turn for this call. */
function lastUserTurn(p: StepPayload): string | null {
  const msgs = (p.requestPayload?.messages ?? []) as ChatMessage[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return null;
}

export function spansForSteps(runId: string, steps: LabRunStepRow[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let lastPromptEmitted: string | null = null;
  for (const step of steps) {
    const p = step.payload as StepPayload;
    if (step.kind === 'tool') {
      out.push({
        trace_id: runId,
        span_id: `${runId}-s${step.seq}`,
        name: `tool.${p.toolName ?? 'unknown'}`,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'tool.args': capContent(JSON.stringify(p.toolInput ?? {})),
          'tool.result': capContent(JSON.stringify(p.toolOutput ?? null)),
          'potion.lab.seq': step.seq,
        },
        ts: new Date(p.clockMs).toISOString(),
      });
      continue;
    }
    if (step.kind !== 'model') continue;
    const prompt = lastUserTurn(p);
    // Emit the user turn only when it CHANGED — the read model appends every
    // gen_ai.prompt to the running context, so re-emitting the same turn on
    // every step would duplicate it in contextBefore.
    const emitPrompt = prompt !== null && prompt !== lastPromptEmitted;
    if (emitPrompt) lastPromptEmitted = prompt;
    out.push({
      trace_id: runId,
      span_id: `${runId}-s${step.seq}`,
      name: 'llm.call',
      ...(p.usage !== undefined
        ? { input_tokens: p.usage.promptTokens, output_tokens: p.usage.completionTokens }
        : {}),
      attributes: {
        'gen_ai.operation.name': 'llm_call',
        ...(emitPrompt && prompt !== null ? { 'gen_ai.prompt': capContent(prompt) } : {}),
        // Empty completions (tool-call steps) are deliberately omitted: the
        // read model skips completion-less llm.call spans as steps, and the
        // tool spans carry that hop's content instead.
        ...(p.responseText !== undefined && p.responseText.length > 0
          ? { 'gen_ai.completion': capContent(p.responseText) }
          : {}),
        'potion.step_index': step.seq,
        'potion.lab.seq': step.seq,
        ...(p.completionId !== undefined ? { 'potion.completion_id': p.completionId } : {}),
        ...(p.frontierTrace !== undefined ? { 'potion.frontier_trace': p.frontierTrace } : {}),
      },
      ts: new Date(p.clockMs).toISOString(),
    });
  }
  return out;
}
