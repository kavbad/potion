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

export function registerPotionGate(api: OpenClawPluginApi, config: PotionGateConfig): PotionGateClient {
  const client = new PotionGateClient(config);
  // W0 (2026-08-31): audit/outcome identity is the per-call actionId, and
  // the state lives PER REGISTRATION — the old module-level map keyed
  // toolName:argsHash was shared across every registered gate and collided
  // on identical concurrent actions. Correlation from before→after hook:
  // by toolCallId when the runtime provides one; otherwise FIFO per
  // (session, tool, argsHash) — order-preserving, never cross-attributing.
  const byCallId = new Map<string, { actionId: string; audit: boolean }>();
  const fifo = new Map<string, Array<{ actionId: string; audit: boolean }>>();
  const fifoKey = (sessionKey: string, toolName: string, argsHash: string) => `${sessionKey}|${toolName}|${argsHash}`;

  api.on(
    'before_tool_call',
    async (event, ctx) => {
      const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? 'default';
      await client.ensureSession(sessionKey);
      const argsHash = argsHashOf(event.params);
      const decision = await client.pore(sessionKey, {
        toolName: event.toolName,
        argsHash,
        argsSummary: JSON.stringify(event.params).slice(0, 400),
      });

      if (decision.decision === 'allow') {
        const entry = { actionId: decision.actionId, audit: decision.audit };
        if (event.toolCallId !== undefined) byCallId.set(event.toolCallId, entry);
        else {
          const k = fifoKey(sessionKey, event.toolName, argsHash);
          const q = fifo.get(k) ?? [];
          q.push(entry);
          fifo.set(k, q);
        }
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
          onResolution: (resolved) =>
            client.resolve(sessionKey, {
              actionId: decision.actionId,
              argsHash,
              resolution: resolved === 'allow-always' ? 'allow-once' : resolved,
            }),
        },
      };
    },
    { priority: 100 },
  );

  api.on('after_tool_call', async (event, ctx) => {
    const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? 'default';
    const argsHash = argsHashOf(event.params);
    let entry: { actionId: string; audit: boolean } | undefined;
    if (event.toolCallId !== undefined) {
      entry = byCallId.get(event.toolCallId);
      byCallId.delete(event.toolCallId);
    } else {
      entry = fifo.get(fifoKey(sessionKey, event.toolName, argsHash))?.shift();
    }
    await client.outcome(sessionKey, {
      toolName: event.toolName,
      argsHash,
      ...(entry !== undefined ? { actionId: entry.actionId } : {}),
      ok: event.error === undefined || event.error === null,
      ...(entry?.audit === true ? { fromAudit: true } : {}),
    });
  });

  return client;
}
