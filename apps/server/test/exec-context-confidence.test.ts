// The serve path must execute a confidence-driven strategy the way the
// harness measured it. See packages/strategies/src/serve-confidence.test.ts
// for what goes wrong when it does not.
import { describe, expect, it } from 'vitest';
import { execContextFor } from '../src/routes/chat.js';

const base = { prices: {} as never, providers: {} as never, resolve: (() => undefined) as never, maxOutputTokens: 400 };

describe('execContextFor', () => {
  it('a cascade asks for confidence — the measured strategy assumed it', () => {
    const ctx = execContextFor({ type: 'cascade', confidenceMethod: 'logprob', stages: [{ model: 'a', escalateIf: { confidenceBelow: 0.5 } }, { model: 'b' }] }, base);
    expect(ctx.captureConfidence).toBe(true);
    expect(ctx.maxOutputTokens).toBe(400);
  });
  it('a composite asks too — its upgrade decision is a confidence', () => {
    expect(execContextFor({ type: 'composite', startModel: 'a', upgradeModel: 'b', upgradeIf: { confidenceBelow: 0.5 } }, base).captureConfidence).toBe(true);
  });
  it('a single does NOT — nobody reads the number, and a reasoning model would pay a retry for it', () => {
    const ctx = execContextFor({ type: 'single', model: 'a' }, base);
    expect('captureConfidence' in ctx).toBe(false);
    expect(ctx).toBe(base);
  });
});
