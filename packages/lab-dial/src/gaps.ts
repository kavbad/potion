// The dial's failure vocabulary — every degradation typed, every code
// produced by ≥1 golden fixture (completeness both directions).

export type DialGap =
  | { code: 'frontier-missing'; clusterId: string; question: string }
  | { code: 'frontier-not-live'; clusterId: string; frontierId: string; question: string }
  | { code: 'no-single-points'; clusterId: string; frontierId: string; question: string }
  | {
      code: 'position-infeasible';
      qualityIndex: number;
      toleranceMs: number;
      /** EVIDENCE-SOURCED (review outcome 3): the exact latencyP95 of the
       * fastest quality-qualifying point — the nearest feasible rung of the
       * ACTUAL ladder, a value copied from a frontier row, never an
       * arithmetic blend. */
      relaxHintMs: number;
      /** What serving would ACTUALLY do (review finding: serving never
       * refuses a compound policy — it serves the fastest
       * quality-qualifying point with latency_violated, or the
       * highest-quality NULL fallback with fallback=1). The dial says so
       * instead of implying a refusal that will not happen. */
      serveWouldServe: { strategyHash: string; mode: 'latency-violated' | 'null-fallback' } | null;
    }
  | {
      /** Tool-bearing only: serving selects over the FULL frontier and
       * 400s tools+composite POST-selection (chat.ts:671) — a position
       * whose emitted policy would let a composite capture the selection
       * at serve time is REFUSED here, so the 400 stays unreachable from
       * Lab paths (the A2/Step 7 DoD). */
      code: 'serve-partition-divergence';
      qualityIndex: number;
      toleranceMs: number;
      /** The composite that would capture the serve-time selection. */
      capturedBy: string;
      question: string;
    }
  | {
      /** An active guarantee rollback IS the operating point (chat.ts
       * swaps it in post-selection) — no dial position is honest while
       * one holds. */
      code: 'rollback-active';
      clusterId: string;
      incidentId: string;
      question: string;
    }
  | { code: 'felt-cap-reached'; sampled: number; capUsd: number };
