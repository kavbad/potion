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
  sidecar: {
    specHash: string;
    choicesHash: string;
    choices: Array<{
      slot: 'brain.policy' | 'brain.toolPolicy';
      basis: { clusterId: string; frontierId: string; strategyHash: string; providerMode: string };
    }>;
  };
  superpowers: Array<{ id: string; scopes: string[]; status: 'not-connected' }>;
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
  superpowers: Array<{ id: string; status: 'not-connected' }>;
  steps: RunStepDto[];
  cost: { meteredUsd: number; estPendingUsd: number };
}
