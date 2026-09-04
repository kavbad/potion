// The outcomes invitation's render condition. The rules it encodes are
// honesty rules, not cosmetics: an unloaded router must never be read as
// "no outcomes", and an org already sending verdicts must never be asked
// for them again.
import { describe, expect, it } from 'vitest';
import { MIN_REQUESTS, shouldInvite } from '@/components/outcomes-nudge';

const withOutcomes = { outcomes: { instrument: 'customer-outcomes', requests: 3 } };
const without = {};

describe('outcomes nudge — when to invite', () => {
  it('invites once there is proven routed traffic and no verdicts anywhere', () => {
    expect(shouldInvite({ routedRequests: MIN_REQUESTS, assignments: [without, without] })).toBe(true);
  });

  it('stays silent below the traffic floor — not someone\'s first minute', () => {
    expect(shouldInvite({ routedRequests: MIN_REQUESTS - 1, assignments: [without] })).toBe(false);
  });

  it('stays silent when the router has not loaded — absent data is not absent outcomes', () => {
    expect(shouldInvite({ routedRequests: 500, assignments: null })).toBe(false);
    expect(shouldInvite({ routedRequests: 500, assignments: [] })).toBe(false);
  });

  it('stays silent as soon as ANY assignment carries verdicts', () => {
    expect(shouldInvite({ routedRequests: 500, assignments: [without, withOutcomes] })).toBe(false);
  });

  it('treats an explicit null outcomes field as absent, not as evidence', () => {
    expect(shouldInvite({ routedRequests: 500, assignments: [{ outcomes: null }] })).toBe(true);
  });
});
