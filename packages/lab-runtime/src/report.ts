// Run report v1 — evidence before advice. Assembled DETERMINISTICALLY from
// durable rows only: the run, its steps, and the request_logs cost join.
// The struggle taxonomy is a closed union of recorded facts; the ONE
// suggested upgrade is chosen by a priority ladder over that evidence —
// no model-generated advice in v1 (a model may PHRASE upgrades in a later
// step, never choose them).
import { and, eq, inArray } from 'drizzle-orm';
import { getLabRun, listLabSteps, requestLogs, type PotionDb } from '@potion/db';
import type { StepPayload } from './checkpoint.js';

export type StruggleEvidence =
  | { code: 'budget-killed'; detail: string }
  | { code: 'run-failed'; detail: string }
  | { code: 'awaiting-human-wait'; question: string }
  | { code: 'not-connected-superpowers'; superpowers: string[] }
  | { code: 'serving-fallback-served'; steps: number }
  | { code: 'latency-violated'; steps: number }
  | { code: 'spec-drift-refused'; detail: string };

export interface StepCostRow {
  seq: number;
  kind: string;
  slot?: 'brain' | 'tools';
  excerpt: string;
  /** Metered from request_logs when resolvable; null → show estimate. */
  meteredUsd: number | null;
  /** The runtime's flat token-rate FUEL estimate — labeled, never blended. */
  estimatedUsd: number | null;
}

export interface RunReportV1 {
  runId: string;
  outcome: string;
  outcomeDetail: string | null;
  missionGoal: string;
  /** What happened: the wrap-up text when present, else the final model
   * response — always from durable rows. */
  summary: string;
  steps: StepCostRow[];
  /** Metered total (request_logs join) — the auditable number. */
  meteredTotalUsd: number;
  /** Estimate total for steps whose join did not resolve. LABELED. */
  estimatedUnmeteredUsd: number;
  fuelCapUsd: number;
  struggles: StruggleEvidence[];
  /** Exactly ONE, chosen by the deterministic ladder below. */
  suggestedUpgrade: { reason: StruggleEvidence['code'] | 'none'; text: string };
}

/** The priority ladder — first matching evidence wins the single slot. */
const UPGRADE_LADDER: Array<{
  code: StruggleEvidence['code'];
  text: (e: StruggleEvidence) => string;
}> = [
  {
    code: 'not-connected-superpowers',
    text: (e) =>
      e.code === 'not-connected-superpowers'
        ? `Connect ${e.superpowers.join(', ')} — this trial ran brain-only; superpowers arrive with connections.`
        : '',
  },
  {
    code: 'budget-killed',
    text: () => 'Raise the worth-per-run answer (fuel derives from it) — this run hit its hard stop.',
  },
  {
    code: 'latency-violated',
    text: () => 'Loosen the latency tolerance one notch — serving had to violate the bound to answer.',
  },
  {
    code: 'serving-fallback-served',
    text: () => 'Re-run the platform sweep for this cluster — serving fell back off the frontier.',
  },
  {
    code: 'awaiting-human-wait',
    text: () => 'Add a standing answer for this check-in to your rules so future runs need not wait.',
  },
  {
    code: 'run-failed',
    text: () => 'Simplify the mission goal — the run failed before completing; a narrower done-definition helps.',
  },
  { code: 'spec-drift-refused', text: () => 'Re-generate the harness — its spec drifted from the running record.' },
];

export async function buildRunReport(
  db: PotionDb,
  runId: string,
  orgId: string,
): Promise<RunReportV1 | null> {
  const run = await getLabRun(db, runId, orgId);
  if (run === null) return null;
  const steps = await listLabSteps(db, runId, orgId);
  const payloads = steps.map((s) => ({ seq: s.seq, kind: s.kind, p: s.payload as StepPayload }));

  // Metered costs: batch join by completionId.
  const completionIds = payloads.map(({ p }) => p.completionId).filter((c): c is string => c !== undefined);
  const metered = new Map<string, number>();
  if (completionIds.length > 0) {
    const rows = await db
      .select({ completionId: requestLogs.completionId, usage: requestLogs.usage })
      .from(requestLogs)
      .where(and(eq(requestLogs.orgId, orgId), inArray(requestLogs.completionId, completionIds)));
    for (const r of rows) {
      const cost = (r.usage as { costUsd?: number } | null)?.costUsd;
      if (r.completionId !== null && typeof cost === 'number') metered.set(r.completionId, cost);
    }
  }

  const stepRows: StepCostRow[] = payloads.map(({ seq, kind, p }) => ({
    seq,
    kind,
    ...(p.slot !== undefined ? { slot: p.slot } : {}),
    excerpt:
      kind === 'model'
        ? (p.responseText ?? '').slice(0, 160)
        : kind === 'tool'
          ? `${p.toolName}(${JSON.stringify(p.toolInput ?? {}).slice(0, 80)})`
          : (p.checkInQuestion ?? '').slice(0, 160),
    meteredUsd: p.completionId !== undefined ? (metered.get(p.completionId) ?? null) : null,
    estimatedUsd: p.estCostUsd ?? null,
  }));
  const meteredTotalUsd = stepRows.reduce((s, r) => s + (r.meteredUsd ?? 0), 0);
  const estimatedUnmeteredUsd = stepRows.reduce(
    (s, r) => s + (r.meteredUsd === null ? (r.estimatedUsd ?? 0) : 0),
    0,
  );

  // Struggle taxonomy — recorded facts only, assembled in a fixed order.
  const struggles: StruggleEvidence[] = [];
  const spec = run.spec as { superpowers?: Array<{ id: string }>; fuel?: { maxUsdPerRun?: number }; mission?: { goal?: string } };
  if ((spec.superpowers ?? []).length > 0) {
    // Pre-MCP: declared superpowers cannot execute — the trial ran
    // brain-only. Typed, visible, never silent (the tool posture).
    struggles.push({
      code: 'not-connected-superpowers',
      superpowers: (spec.superpowers ?? []).map((s) => s.id),
    });
  }
  if (run.state === 'killed-budget') {
    struggles.push({ code: 'budget-killed', detail: run.stateReason ?? 'hard stop' });
  }
  if (run.state === 'failed') {
    if ((run.stateReason ?? '').includes('spec drift')) {
      struggles.push({ code: 'spec-drift-refused', detail: run.stateReason ?? '' });
    } else {
      struggles.push({ code: 'run-failed', detail: run.stateReason ?? 'failed' });
    }
  }
  if (run.state === 'awaiting-human' && run.pendingQuestion !== null) {
    struggles.push({ code: 'awaiting-human-wait', question: run.pendingQuestion });
  }
  const fallbackSteps = payloads.filter(({ p }) => /(?:^|;)fallback=1/.test(p.frontierTrace ?? '')).length;
  if (fallbackSteps > 0) struggles.push({ code: 'serving-fallback-served', steps: fallbackSteps });
  const violatedSteps = payloads.filter(({ p }) => /latency_violated=1/.test(p.frontierTrace ?? '')).length;
  if (violatedSteps > 0) struggles.push({ code: 'latency-violated', steps: violatedSteps });

  // Exactly ONE upgrade: first ladder rung with matching evidence.
  let suggestedUpgrade: RunReportV1['suggestedUpgrade'] = {
    reason: 'none',
    text: 'Raise the dial one rung — nothing struggled; the next quality level is the natural experiment.',
  };
  for (const rung of UPGRADE_LADDER) {
    const evidence = struggles.find((s) => s.code === rung.code);
    if (evidence !== undefined) {
      suggestedUpgrade = { reason: rung.code, text: rung.text(evidence) };
      break;
    }
  }

  const modelPayloads = payloads.filter(({ kind }) => kind === 'model');
  const last = modelPayloads[modelPayloads.length - 1];
  return {
    runId,
    outcome: run.state,
    outcomeDetail: run.stateReason,
    missionGoal: spec.mission?.goal ?? '',
    summary: (last?.p.responseText ?? '').slice(0, 600),
    steps: stepRows,
    meteredTotalUsd,
    estimatedUnmeteredUsd,
    fuelCapUsd: spec.fuel?.maxUsdPerRun ?? 0,
    struggles,
    suggestedUpgrade,
  };
}
