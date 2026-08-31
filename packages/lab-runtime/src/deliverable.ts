// Deliverable extraction (P1) — derive the filed brief from the durable
// record, at read time. No new storage: the deliverable IS the final model
// step's response text, parsed by the same deterministic parser the
// completion law used. If the law said 'completed', this finds the brief;
// on any other terminal it returns what it can (a failed check has no
// deliverable, and that absence is the honest answer).
import { parseBrief, type Brief, type HarnessSpec } from '@potion/lab-spec';

export interface DeliverableResult {
  brief: Brief;
  /** The step whose response text IS the deliverable. */
  atSeq: number;
}

/** The TASK-run twin (2026-08-31, the generational pass): a completed task
 * has no schema contract, but it HAS a deliverable — the final answer that
 * met the done-definition (or the wrap-up that recapped it). Extracting it
 * here makes every completed run end in a rendered, judged RESULT instead
 * of a bare download list. Derived from the record; no second storage. */
export function extractReport(
  spec: HarnessSpec,
  steps: Array<{ seq: number; kind: string; payload: { responseText?: string; toolCalls?: unknown[]; finishReason?: string; requestPayload?: { messages?: Array<{ content?: string }> } } }>,
): { report: string; atSeq: number } | null {
  if (spec.contract !== undefined || spec.mission.kind !== 'task') return null;
  const ordered = [...steps].sort((a, b) => b.seq - a.seq);
  for (const s of ordered) {
    if (s.kind !== 'model') continue;
    const calls = s.payload.toolCalls ?? [];
    if (calls.length > 0 || s.payload.finishReason !== 'stop') continue;
    // 2026-08-31 (found live, on the operator's own screen): the WRAP-UP is
    // process narration ("Summary of this run: 1. I received…"), not the
    // answer — the report is the done-shaped step the completion law
    // accepted, which sits BEFORE the wrap-up. A step answering the wrap-up
    // prompt is skipped.
    const msgs = s.payload.requestPayload?.messages ?? [];
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
    if (typeof last?.content === 'string' && last.content.startsWith('Summarize what you did in this run')) continue;
    const text = (s.payload.responseText ?? '').trim();
    if (text.length < 40) continue; // a bare "done." is not a report
    return { report: text, atSeq: s.seq };
  }
  return null;
}

export function extractDeliverable(
  spec: HarnessSpec,
  steps: Array<{ seq: number; kind: string; payload: { responseText?: string; toolCalls?: unknown[]; finishReason?: string } }>,
): DeliverableResult | null {
  if (spec.contract === undefined) return null;
  // Scan newest-first: the deliverable is the LAST no-tool natural stop
  // that parses — exactly the step the completion law accepted.
  const ordered = [...steps].sort((a, b) => b.seq - a.seq);
  for (const s of ordered) {
    if (s.kind !== 'model') continue;
    const calls = s.payload.toolCalls ?? [];
    if (calls.length > 0 || s.payload.finishReason !== 'stop') continue;
    const parsed = parseBrief(s.payload.responseText ?? '');
    if (parsed.ok) return { brief: parsed.brief, atSeq: s.seq };
  }
  return null;
}
