// What a strategy shape can honestly carry (MIXING M3, 2026-08-23). A
// capability is a property of the shape, declared here where shapes are
// executed, not inferred at the route from `type === 'single'`.
import type { ProgramNode, StrategyConfig } from '@potion/core';

export interface StrategyCapabilities {
  /** Tool-carrying requests: every stage that can be the answering call is
   * a single model call with the tools forwarded, and a tool call ends the
   * strategy (escalation judges answers; a tool call is a decision). */
  canServeTools: boolean;
  /** Live token relay from the answering call. */
  canStream: boolean;
}

export function strategyCapabilities(config: StrategyConfig): StrategyCapabilities {
  switch (config.type) {
    case 'single':
      return { canServeTools: true, canStream: true };
    case 'cascade':
      // Tools forwarded to every stage; a stage that returns a tool call is
      // terminal. Streaming a cascade needs the answering stage known before
      // its tokens flow — not built yet.
      return { canServeTools: true, canStream: false };
    case 'composite':
      // The keep/upgrade check scores text; a tool call has none to judge.
      return { canServeTools: false, canStream: true };
    case 'program':
      return { canServeTools: programCarriesTools(config.body), canStream: false };
    default:
      return { canServeTools: false, canStream: false };
  }
}

/**
 * C4b/C4 rung 4: can this program shape carry the caller's tools?
 *
 * A bare `call` can: it is a single-model call wearing C4 parameters — effort,
 * a prompt variant, a context or tool selection — and tool semantics survive
 * all of them, because none READS the answer. That is the point: agent traffic
 * gets the new axes without giving up tools.
 *
 * A gate can, but only if it observes rather than judges. `tool-called` asks
 * whether a decision happened; every other check reads text or confidence, and
 * a tool call carries neither — the interpreter makes one terminal through
 * them, so the gate would never have run anyway.
 *
 * `vote` and `pick` never can: taking a majority of tool calls, or asking a
 * judge to rank them as prose, is not a thing.
 */
export function programCarriesTools(node: ProgramNode): boolean {
  switch (node.op) {
    case 'call':
      return true;
    case 'if':
      return node.check.kind === 'tool-called' && programCarriesTools(node.then) && programCarriesTools(node.else);
    case 'vote':
    case 'pick':
      return false;
  }
}
