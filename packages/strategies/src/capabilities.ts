// What a strategy shape can honestly carry (MIXING M3, 2026-08-23). A
// capability is a property of the shape, declared here where shapes are
// executed, not inferred at the route from `type === 'single'`.
import type { StrategyConfig } from '@potion/core';

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
    default:
      return { canServeTools: false, canStream: false };
  }
}
