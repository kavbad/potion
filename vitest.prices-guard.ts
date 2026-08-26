// SUITE-LEVEL GUARD: the committed prices.json must be byte-identical after
// any vitest run.
//
// Why it exists: the pre-S5 research:scan handler wrote its merged price
// table to ctx.pricesPath, and a stale @potion/workers dist can resurrect
// that writer even though the source is clean — which contaminated the repo
// file three times (2026-08-22 → bb11491; third recurrence 2026-08-25),
// each time silently: the suite stayed green and the damage surfaced later
// as the dashboard walkthrough's step-12 timeout (a pre-contaminated seed
// makes the scan find nothing new, so no cycles ever enqueue).
//
// This runs in vitest's main process around the whole run (globalSetup), so
// no worker, handler, or dist artifact can dodge it. A content change fails
// the run LOUDLY; an mtime-only change (same bytes rewritten) is warned.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PRICES = fileURLToPath(new URL('./prices.json', import.meta.url));

function snapshot(): { sha256: string; mtimeMs: number } {
  return {
    sha256: createHash('sha256').update(readFileSync(PRICES)).digest('hex'),
    mtimeMs: statSync(PRICES).mtimeMs,
  };
}

export default function pricesGuard(): () => void {
  const before = snapshot();
  return () => {
    const after = snapshot();
    if (after.sha256 !== before.sha256) {
      throw new Error(
        `TEST RUN WROTE THE COMMITTED prices.json (${PRICES}).\n` +
          `sha256 before ${before.sha256}\n` +
          `sha256 after  ${after.sha256}\n` +
          `Something in this run held the repo file as its prices path — the ` +
          `pre-S5 scan-writer class of bug (see apps/server/test/` +
          `prices-immutability.test.ts). Inspect \`git diff prices.json\`, ` +
          `revert with \`git checkout -- prices.json\`, and if @potion/workers ` +
          `dist could be stale, rebuild: \`pnpm -r build\`.`,
      );
    }
    if (after.mtimeMs !== before.mtimeMs) {
      console.error(
        `[prices-guard] WARNING: prices.json mtime changed during the test run ` +
          `(content identical). Something re-wrote the repo file with the same ` +
          `bytes — find and fix it before it writes different ones.`,
      );
    }
  };
}
