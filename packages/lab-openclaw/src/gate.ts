// L-G4 — the Potion gate client (Lab direction v2, 2026-08-26): the four
// runtime-gate calls, with the failure posture that matters more than the
// happy path:
//
//   FAIL CLOSED TO SUPERVISION, NOT TO A BRICK. If the gate is unreachable,
//   the answer is 'hold' — the human can still approve locally through the
//   runtime's own surface; the evidence for that action is lost, autonomy
//   is not silently granted, and the agent is not dead. A gate outage must
//   never mean "everything is allowed" and should not mean "nothing works."
//
// Zero dependencies: plain fetch, structural types, so the client embeds in
// any runtime plugin without dragging Potion's workspace along.

import { createHash, randomUUID } from 'node:crypto';

export interface PotionGateConfig {
  /** https://api.withpotion.com */
  apiUrl: string;
  /** A Potion serving key (Bearer). Never a session cookie. */
  apiKey: string;
  harnessHash: string;
  /** Per-call budget; the gate itself answers in tens of ms. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type PoreDecision =
  | { decision: 'allow'; audit: boolean }
  | { decision: 'hold'; question: string }
  | { decision: 'blocked'; reason: string };

export type PoreResolution = 'allow-once' | 'deny' | 'timeout' | 'cancelled';

const HOLD_UNREACHABLE: PoreDecision = {
  decision: 'hold',
  question:
    'The Potion gate is unreachable — this action needs your approval here, and it will not count toward earned autonomy.',
};

export class PotionGateClient {
  /** W0 (2026-08-31): per-sessionKey run state. The old single mutable
   * runId attributed every later session's actions to whichever session
   * initialized first — evidence landing on the wrong run is worse than
   * no evidence. */
  private readonly runs = new Map<string, string>();

  constructor(private readonly config: PotionGateConfig) {}

  private async post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    const f = this.config.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      const res = await f(`${this.config.apiUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Register (idempotently) the runtime session this client speaks for.
   * Per-sessionKey: two sessions on one client get two runs. */
  async ensureSession(sessionKey: string): Promise<string | null> {
    const known = this.runs.get(sessionKey);
    if (known !== undefined) return known;
    const body = await this.post('/v1/lab/runtime/sessions', {
      harnessHash: this.config.harnessHash,
      sessionKey,
      runtime: 'openclaw',
    });
    const runId = typeof body?.runId === 'string' ? body.runId : null;
    if (runId !== null) this.runs.set(sessionKey, runId);
    return runId;
  }

  /** The gate decision for one proposed action. Mints the per-call
   * actionId — the identity that audit state and outcomes bind to, so
   * identical concurrent actions never share a fate. */
  async pore(
    sessionKey: string,
    input: { toolName: string; argsHash: string; argsSummary?: string },
  ): Promise<PoreDecision & { actionId: string }> {
    const actionId = randomUUID();
    const runId = this.runs.get(sessionKey);
    if (runId === undefined) return { ...HOLD_UNREACHABLE, actionId };
    const body = await this.post('/v1/lab/runtime/pore', { runId, actionId, ...input });
    if (body?.decision === 'allow') return { decision: 'allow', audit: body.audit === true, actionId };
    if (body?.decision === 'blocked')
      return { decision: 'blocked', reason: typeof body.reason === 'string' ? body.reason : 'blocked', actionId };
    if (body?.decision === 'hold')
      return { decision: 'hold', question: typeof body.question === 'string' ? body.question : 'Allow this action?', actionId };
    return { ...HOLD_UNREACHABLE, actionId }; // network failure, 4xx, anything else: supervise
  }

  /** Report how the human resolved a hold. Best-effort: a lost report loses
   * evidence, never correctness. */
  async resolve(sessionKey: string, input: { actionId: string; argsHash: string; resolution: PoreResolution }): Promise<void> {
    const runId = this.runs.get(sessionKey);
    if (runId === undefined) return;
    await this.post('/v1/lab/runtime/pore/resolve', { runId, ...input });
  }

  /** Report the execution outcome (validator-grade evidence later). */
  async outcome(
    sessionKey: string,
    input: { toolName: string; argsHash: string; actionId?: string; ok: boolean; fromAudit?: boolean },
  ): Promise<void> {
    const runId = this.runs.get(sessionKey);
    if (runId === undefined) return;
    await this.post('/v1/lab/runtime/outcome', { runId, ...input });
  }
}

/** Fingerprint for a tool call's arguments — sha256 over sorted-key JSON.
 * W0 (2026-08-31): the old djb2-xor hex claimed "the gate only needs
 * equality, not cryptography" — false. This hash IS the approval identity
 * (checkInAction.argsHash binds what the human authorized to what runs);
 * a collision means an approval could authorize different arguments.
 * Human authorization binds to a real hash. node:crypto is a builtin —
 * the zero-workspace-dependency property of this client holds. */
export function argsHashOf(params: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(params))).digest('hex');
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
