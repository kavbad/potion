// L-G4 — the OpenClaw plugin shim (Lab direction v2, 2026-08-26).
//
// Wires Potion's runtime gate into OpenClaw's before_tool_call /
// after_tool_call hooks (docs.openclaw.ai/plugins/hooks). The mapping:
//
//   Potion 'allow'   → no block (autonomy was EARNED; the standing audit
//                      sample still reports its outcome)
//   Potion 'hold'    → requireApproval — and allowedDecisions deliberately
//                      OMITS 'allow-always'. That switch is the thing this
//                      product replaces: standing autonomy comes from the
//                      grant, earned per action class, revocable on drift —
//                      never from a chat-surface toggle.
//   Potion 'blocked' → { block: true } — terminal.
//   Gate unreachable → hold (fail closed to supervision, not to a brick).
//
// OpenClaw's API is consumed structurally (no dependency on the openclaw
// package): the fragment below is exactly the documented hook surface this
// shim touches, so a runtime upgrade that changes it fails the build here,
// not silently in production.
import { argsHashOf, PotionGateClient, type PotionGateConfig } from './gate.js';

/** The documented before_tool_call event/context fragment we consume. */
export interface OpenClawToolEvent {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
}
export interface OpenClawHookCtx {
  sessionKey?: string;
  sessionId?: string;
}
export interface OpenClawBeforeToolCallResult {
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: 'info' | 'warning' | 'critical';
    allowedDecisions?: Array<'allow-once' | 'allow-always' | 'deny'>;
    onResolution?: (decision: 'allow-once' | 'allow-always' | 'deny' | 'timeout' | 'cancelled') => Promise<void> | void;
  };
}
export interface OpenClawAfterToolCallEvent extends OpenClawToolEvent {
  error?: unknown;
}
export interface OpenClawPluginApi {
  on(
    name: 'before_tool_call',
    handler: (event: OpenClawToolEvent, ctx: OpenClawHookCtx) => Promise<OpenClawBeforeToolCallResult | void>,
    opts?: { priority?: number },
  ): void;
  on(
    name: 'after_tool_call',
    handler: (event: OpenClawAfterToolCallEvent, ctx: OpenClawHookCtx) => Promise<void>,
    opts?: { priority?: number },
  ): void;
}

/** Per-session audit flags: an allowed-with-audit action reports fromAudit
 * on its outcome so the sampled-review stream stays labeled. */
const auditFlags = new Map<string, boolean>();

export function registerPotionGate(api: OpenClawPluginApi, config: PotionGateConfig): PotionGateClient {
  const client = new PotionGateClient(config);

  api.on(
    'before_tool_call',
    async (event, ctx) => {
      const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? 'default';
      await client.ensureSession(sessionKey);
      const argsHash = argsHashOf(event.params);
      const decision = await client.pore({
        toolName: event.toolName,
        argsHash,
        argsSummary: JSON.stringify(event.params).slice(0, 400),
      });

      if (decision.decision === 'allow') {
        auditFlags.set(`${event.toolName}:${argsHash}`, decision.audit);
        return; // earned autonomy — no block, no ceremony
      }
      if (decision.decision === 'blocked') {
        return { block: true, blockReason: `Potion: ${decision.reason}` };
      }
      return {
        requireApproval: {
          title: `Potion: ${event.toolName} needs approval`,
          description: decision.question,
          severity: 'warning',
          // No 'allow-always'. Standing autonomy is earned through the
          // grant, per action class, revocable on drift — not toggled here.
          allowedDecisions: ['allow-once', 'deny'],
          // Defensive: we never OFFER allow-always, but if the runtime hands
          // one through anyway it is still a single human allowance — record
          // it as allow-once; standing autonomy only ever comes from grants.
          onResolution: (resolved) => client.resolve(argsHash, resolved === 'allow-always' ? 'allow-once' : resolved),
        },
      };
    },
    { priority: 100 },
  );

  api.on('after_tool_call', async (event) => {
    const argsHash = argsHashOf(event.params);
    const key = `${event.toolName}:${argsHash}`;
    const fromAudit = auditFlags.get(key) === true;
    auditFlags.delete(key);
    await client.outcome({
      toolName: event.toolName,
      argsHash,
      ok: event.error === undefined || event.error === null,
      ...(fromAudit ? { fromAudit } : {}),
    });
  });

  return client;
}
