// execute(): strategy interpreter entry point (SPEC §3). Pure functions, one
// file per strategy type. `stream` is honored ONLY by 'single' and
// 'composite' (M3 #23, SPEC §12.6).
import type { ChatMessage, StrategyConfig } from '@potion/core';
import { runBestOfN } from './best-of-n.js';
import { runCascade } from './cascade.js';
import { runComposite } from './composite.js';
import { runDecompose } from './decompose.js';
import { runDraftVerify } from './draft-verify.js';
import { runEnsemble } from './ensemble.js';
import { runSingle } from './single.js';
import type { ExecContext, StrategyResult } from './types.js';
import { runProgram } from './program.js';

export async function execute(
  strategy: StrategyConfig,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  switch (strategy.type) {
    case 'single':
      return runSingle(strategy.model, messages, ctx);
    case 'cascade':
      return runCascade(strategy, messages, ctx);
    case 'best-of-n':
      return runBestOfN(strategy, messages, ctx);
    case 'draft-verify':
      return runDraftVerify(strategy, messages, ctx);
    case 'ensemble':
      return runEnsemble(strategy, messages, ctx);
    case 'decompose':
      return runDecompose(strategy, messages, ctx);
    case 'program':
      return runProgram(strategy.name, strategy.body, messages, ctx);
    case 'composite':
      return runComposite(strategy, messages, ctx);
  }
}
