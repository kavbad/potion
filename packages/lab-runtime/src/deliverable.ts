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
