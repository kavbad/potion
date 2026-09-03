// Frontier Notes — the publish gate (F2 of the fleet,
// docs/RESEARCH-FLEET.md R3): publication is an ACT CLASS on the author's
// own harness, asked through the SAME decideAction gateway every other act
// answers to (the external runtime-gate surface, W1). Born supervised: the
// grant starts 'supervised' at the fail-closed irreversible-act tier, so
// the first publishes HOLD for the operator; clean validated outcomes
// graduate it through the standard path, and a reversal re-supervises it —
// publication autonomy is earned, never configured.
//
// The approval binds to CONTENT: argsHash is the sha256 of the exact issue
// draft, and actionId is derived from it — approving one draft approves
// only that draft. A held issue is released by re-checking the SAME
// fingerprint (frontier-notes-release), never by re-drafting.
import { createHash } from 'node:crypto';
import type { Draft } from './write.js';

export const PUBLISH_ACTION_CLASS = 'publish_frontier_notes';

export interface PublishGateOptions {
  /** Server origin, e.g. https://api.withpotion.com */
  url: string;
  /** Bearer serving key for the runtime-gate surface (pk_…). */
  apiKey: string;
  /** The AUTHOR's harness — its constitution and grants govern the act. */
  harnessHash: string;
  /** Dashboard session (potion_session cookie value) — used only to read
   * the gate session's steps for a prior fingerprint-bound resolution. */
  session?: string;
  /** A fingerprint-bound resolution the CALLER read from the durable
   * record (lab_run_steps carries the operator's answer; the dashboard
   * run route cannot serve runx- sessions yet, so ops scripts look the
   * answer up in the record and pass it here). 'approved' allows exactly
   * this draft; 'rejected' blocks it. */
  priorResolution?: 'approved' | 'rejected';
  fetchImpl?: typeof fetch;
}

export interface PublishGateResult {
  decision: 'allow' | 'hold' | 'blocked';
  /** Standing sampled audit flag when allowed autonomously. */
  audit?: boolean;
  /** The supervisor question when held. */
  question?: string;
  /** The external gate session (runx-…) the decision lives on. */
  runId: string;
  actionId: string;
  argsHash: string;
  /** True when the allow came from an operator's earlier allow-once on
   * this exact fingerprint rather than a fresh gateway allow. */
  priorResolution?: boolean;
  /** Transport/typed failure — treat as HOLD (fail closed, publish waits). */
  error?: string;
}

/** The content fingerprint the approval binds to. */
export function publishArgsHash(week: string, draft: Draft): string {
  const canonical = JSON.stringify({
    week,
    title: draft.title,
    summary: draft.summary,
    plain: draft.plain,
    lede: draft.lede,
    frontierNote: draft.frontierNote,
    auditionNote: draft.auditionNote,
    mixingNote: draft.mixingNote,
    takeaway: draft.takeaway,
    faq: draft.faq,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function publishActionId(week: string, argsHash: string): string {
  return `pub-${week.toLowerCase()}-${argsHash.slice(0, 8)}`;
}

interface StepDto {
  kind?: string;
  excerpt?: string;
}

/**
 * Ask the gateway whether this exact issue may publish. Never throws: any
 * transport failure returns decision 'hold' with the error named — a gate
 * that cannot be reached must never wave a publish through.
 */
export async function publishGateDecision(
  week: string,
  draft: Draft,
  o: PublishGateOptions,
): Promise<PublishGateResult> {
  const fetchFn = o.fetchImpl ?? fetch;
  const base = o.url.replace(/\/$/, '');
  const bearer = { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' };
  const argsHash = publishArgsHash(week, draft);
  const actionId = publishActionId(week, argsHash);
  const fail = (error: string): PublishGateResult => ({ decision: 'hold', runId: '', actionId, argsHash, error });

  let runId: string;
  try {
    const res = await fetchFn(`${base}/v1/lab/runtime/sessions`, {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({ harnessHash: o.harnessHash, sessionKey: `frontier-notes-publisher-${week.toLowerCase()}`, runtime: 'external' }),
    });
    if (!res.ok) return fail(`gate session HTTP ${res.status}`);
    const body = (await res.json()) as { runId?: string };
    if (typeof body.runId !== 'string') return fail('gate session returned no runId');
    runId = body.runId;
  } catch (e) {
    return fail(`gate session: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
  }

  // A prior fingerprint-bound resolution consumes exactly once per draft:
  // the operator's allow-once (or deny) on THIS actionId decides without
  // re-asking. The record is the truth — passed in by the caller when it
  // read the record itself, or read from the steps when the API serves them.
  if (o.priorResolution === 'approved') return { decision: 'allow', runId, actionId, argsHash, priorResolution: true };
  if (o.priorResolution === 'rejected') return { decision: 'blocked', runId, actionId, argsHash, question: 'rejected by supervisor', priorResolution: true };
  if (o.session) {
    try {
      const res = await fetchFn(`${base}/api/lab/runs/${runId}`, { headers: { cookie: `potion_session=${o.session}` } });
      if (res.ok) {
        const dto = (await res.json()) as { steps?: StepDto[] };
        for (const s of dto.steps ?? []) {
          const text = s.excerpt ?? '';
          if (!text.includes(`[action ${actionId}]`)) continue;
          if (text.includes('approved')) return { decision: 'allow', runId, actionId, argsHash, priorResolution: true };
          if (text.includes('rejected by supervisor')) return { decision: 'blocked', runId, actionId, argsHash, question: 'rejected by supervisor', priorResolution: true };
        }
      }
    } catch {
      // unreadable steps never wave a publish through; fall through to the pore
    }
  }

  try {
    const res = await fetchFn(`${base}/v1/lab/runtime/pore`, {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({
        runId,
        actionId,
        toolName: PUBLISH_ACTION_CLASS,
        argsHash,
        argsSummary: `Publish Frontier Notes ${week}: "${draft.title.slice(0, 140)}"`,
      }),
    });
    if (!res.ok) return { ...fail(`pore HTTP ${res.status}`), runId };
    const body = (await res.json()) as { decision?: string; audit?: boolean; question?: string; reason?: string };
    if (body.decision === 'allow') return { decision: 'allow', runId, actionId, argsHash, ...(body.audit !== undefined ? { audit: body.audit } : {}) };
    if (body.decision === 'blocked') return { decision: 'blocked', runId, actionId, argsHash, ...(body.reason !== undefined ? { question: body.reason } : {}) };
    return { decision: 'hold', runId, actionId, argsHash, ...(body.question !== undefined ? { question: body.question } : {}) };
  } catch (e) {
    return { ...fail(`pore: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)), runId };
  }
}

/** Report the publish execution back to the gate — the outcome stream the
 * graduation pass reads. Best-effort: a lost report never unpublishes. */
export async function reportPublishOutcome(
  r: Pick<PublishGateResult, 'runId' | 'actionId' | 'argsHash'>,
  ok: boolean,
  o: PublishGateOptions,
): Promise<void> {
  if (!r.runId) return;
  const fetchFn = o.fetchImpl ?? fetch;
  try {
    await fetchFn(`${o.url.replace(/\/$/, '')}/v1/lab/runtime/outcome`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId: r.runId, actionId: r.actionId, toolName: PUBLISH_ACTION_CLASS, argsHash: r.argsHash, ok }),
    });
  } catch {
    // best-effort by design
  }
}
