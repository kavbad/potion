// shadow:judge is RETIRED (2026-09-01): candidates are judge-scored
// in-process on the serving path (apps/server shadow.ts — the guarantee's
// G0.1 posture: answers never transit the queue). The kind stays registered
// so a legacy queued job — including the old TEXT-BEARING payload shape the
// enqueuer actually sent (which the old stub's `shadowResultId` validation
// threw on) — drains as a typed no-op instead of erroring.
import { describe, expect, it } from 'vitest';
import { shadowJudgeHandler } from './handlers.js';
import type { JobContext } from './handlers.js';

describe('shadow:judge tombstone', () => {
  it('drains any legacy payload as a typed no-op — never throws, never scores', async () => {
    const legacyTextPayload = {
      orgId: 'org-x',
      requestId: 'chatcmpl-legacy',
      clusterId: 'code-gen',
      candidateHash: 'abc',
      candidateText: 'a candidate answer',
      primaryText: 'the primary answer',
    };
    await expect(
      shadowJudgeHandler(legacyTextPayload as never, {} as JobContext),
    ).resolves.toMatchObject({ retired: true });
    await expect(
      shadowJudgeHandler({ shadowResultId: 'sr-1' }, {} as JobContext),
    ).resolves.toMatchObject({ retired: true });
  });
});
