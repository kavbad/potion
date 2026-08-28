// The Lab client-facing DTO shapes deriveFormState consumes — these mirror
// the /api/lab/* responses (apps/server/src/routes/lab.ts) and are the
// canonical client types for them. The audit's source accessors are typed
// against THESE, so a route reshape is a compile error here, and the
// walkthrough validates them against live responses.
import type { HarnessSpec } from '@potion/lab-spec';

export interface DialViewDto {
  feasible: boolean;
  position: { qualityIndex: number; toleranceMs?: number };
  policy?: unknown;
  strategyHash?: string;
  strategyType?: string;
  quality?: number;
  costPer1K?: number;
  latencyP95?: number;
  frontierId?: string;
  frontierVersion?: number;
  gap?: { code: string; relaxHintMs?: number };
}

export interface HarnessDto {
  harnessHash: string;
  name: string;
  clusterId: string;
  createdAt: string;
  spec: HarnessSpec | null;
  /** The canonical spec FILE — byte truth for the machinery editor. */
  specText?: string;
  sidecar: {
    specHash: string;
    choicesHash: string;
    choices: Array<{
      slot: 'brain.policy' | 'brain.toolPolicy';
      basis: {
        clusterId: string;
        frontierId: string;
        frontierVersion?: number;
        strategyHash: string;
        providerMode: string;
        suiteContentHash?: string;
      };
      partition?: 'single-only' | 'full';
      alternatives?: number;
    }>;
    /** The work profile — kinds of work the mission contains, primary
     * first (interpretation provenance; serving routes per step). */
    workProfile?: string[];
    /** Set when the spec was operator-edited: the row it was edited from. */
    editedFrom?: string;
  };
  superpowers: Array<{
    id: string;
    scopes: string[];
    /** Step 10: derived server-side from the grants table via the ONE
     * derivation (grantConnectionStatus) — never a UI guess. */
    status: 'not-connected' | 'connected' | 'expired' | 'revoked';
  }>;
  dial: {
    brain: { ok: boolean; frontierId?: string; views?: DialViewDto[]; gap?: unknown };
    tools?: { ok: boolean; frontierId?: string; views?: DialViewDto[]; gap?: unknown };
  };
}

export interface MemoryDto {
  harnessHash: string;
  entries: Array<{ key: string; value: unknown; rendered: string; updatedAt: string }>;
}

export interface RunStepDto {
  seq: number;
  kind: 'model' | 'tool' | 'check-in';
  at: string;
  slot: 'brain' | 'tools' | null;
  excerpt: string;
  estCostUsd?: number;
  meteredCostUsd?: number | null;
  costLabel?: 'metered' | 'est.';
  provenance?: string | null;
  simulated?: boolean;
  /** Step 9 additive DTO flags (parsed server-side from the trace). */
  fallback?: boolean;
  latencyViolated?: boolean;
}

export interface RunDto {
  runId: string;
  harnessHash: string;
  harnessName: string;
  state:
    | 'pending'
    | 'running'
    | 'awaiting-human'
    | 'completed'
    | 'failed'
    | 'killed-budget'
    | 'killed-operator';
  stateReason: string | null;
  pendingQuestion: string | null;
  createdAt: string;
  updatedAt: string;
  superpowers: Array<{ id: string; status: 'not-connected' | 'connected' | 'expired' | 'revoked' }>;
  steps: RunStepDto[];
  cost: { meteredUsd: number; estPendingUsd: number };
}
