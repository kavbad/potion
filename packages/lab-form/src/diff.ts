// THE INTERPOLATION HONESTY RULE, mechanized (spec §7): discrete events
// are emitted ONLY here, only from what changed between two derivations.
// Identical inputs emit nothing — stillness is information. The est→metered
// upgrade RE-TINTS an existing pulse's residue; it never re-fires.
import type { FormState, StepEvent } from './form-state.js';

export interface FormEvents {
  /** New model steps since the previous derivation — one pulse each. */
  pulses: StepEvent[];
  /** Steps whose cost resolved est→metered — re-tint, never re-fire. */
  retints: Array<{ seq: number; meteredUsd: number }>;
  /** New anomaly-flagged steps — one persistent bead each. */
  anomalies: Array<{ seq: number; kind: 'fallback' | 'latency' }>;
  /** Run-state transition, when one occurred. */
  stateChange: { from: string; to: string } | null;
}

export function diffFormState(prev: FormState | null, next: FormState): FormEvents {
  const prevBySeq = new Map<number, StepEvent>((prev?.stepEvents ?? []).map((e) => [e.seq, e]));
  const pulses: StepEvent[] = [];
  const retints: FormEvents['retints'] = [];
  const anomalies: FormEvents['anomalies'] = [];
  for (const e of next.stepEvents) {
    const was = prevBySeq.get(e.seq);
    if (was === undefined) {
      pulses.push(e);
      if (e.anomaly !== null) anomalies.push({ seq: e.seq, kind: e.anomaly });
    } else {
      if (was.hollow && !e.hollow && e.meteredUsd !== null) {
        retints.push({ seq: e.seq, meteredUsd: e.meteredUsd });
      }
      if (was.anomaly === null && e.anomaly !== null) {
        anomalies.push({ seq: e.seq, kind: e.anomaly });
      }
    }
  }
  const stateChange =
    prev !== null && prev.glow.mode !== next.glow.mode
      ? { from: prev.glow.mode, to: next.glow.mode }
      : null;
  return { pulses, retints, anomalies, stateChange };
}
