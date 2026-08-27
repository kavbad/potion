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
  private runId: string | null = null;

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

  /** Register (idempotently) the runtime session this client speaks for. */
  async ensureSession(sessionKey: string): Promise<string | null> {
    if (this.runId) return this.runId;
    const body = await this.post('/v1/lab/runtime/sessions', {
      harnessHash: this.config.harnessHash,
      sessionKey,
      runtime: 'openclaw',
    });
    this.runId = typeof body?.runId === 'string' ? body.runId : null;
    return this.runId;
  }

  /** The gate decision for one proposed action. */
  async pore(input: { toolName: string; argsHash: string; argsSummary?: string }): Promise<PoreDecision> {
    if (!this.runId) return HOLD_UNREACHABLE;
    const body = await this.post('/v1/lab/runtime/pore', { runId: this.runId, ...input });
    if (body?.decision === 'allow') return { decision: 'allow', audit: body.audit === true };
    if (body?.decision === 'blocked')
      return { decision: 'blocked', reason: typeof body.reason === 'string' ? body.reason : 'blocked' };
    if (body?.decision === 'hold')
      return { decision: 'hold', question: typeof body.question === 'string' ? body.question : 'Allow this action?' };
    return HOLD_UNREACHABLE; // network failure, 4xx, anything else: supervise
  }

  /** Report how the human resolved a hold. Best-effort: a lost report loses
   * evidence, never correctness. */
  async resolve(argsHash: string, resolution: PoreResolution): Promise<void> {
    if (!this.runId) return;
    await this.post('/v1/lab/runtime/pore/resolve', { runId: this.runId, argsHash, resolution });
  }

  /** Report the execution outcome (validator-grade evidence later). */
  async outcome(input: { toolName: string; argsHash: string; ok: boolean; fromAudit?: boolean }): Promise<void> {
    if (!this.runId) return;
    await this.post('/v1/lab/runtime/outcome', { runId: this.runId, ...input });
  }
}

/** Stable fingerprint for a tool call's arguments — sorted-key JSON, FNV-free
 * plain djb2-xor hex; the gate only needs equality, not cryptography. */
export function argsHashOf(params: unknown): string {
  const canonical = JSON.stringify(sortKeys(params));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 + c) * 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
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
