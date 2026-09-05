// THE COLD WALKTHROUGH (2026-09-05) — three defects found by signing in to
// production as a brand-new account and trying to do the thing the product
// is for. Between them they explain four sign-ups and three workers: two
// people could not reach the compose box at all, and the one who did got a
// run that failed with an internal token for a reason.
//
// Each test below is the wall, written down.
import { describe, expect, it } from 'vitest';
import { gateAppliesTo } from '@/components/first-run';
import { failureReason } from '@/components/lab-chat';
import { GALLERY } from '@/components/lab-gallery';

describe('the router question does not stand in front of Workers', () => {
  it('is exempt on every /lab surface', () => {
    // It is a FIXED, opaque, full-viewport overlay at z-50 mounted by
    // app-shell on every signed-in route, and its first beat has no skip —
    // Continue stays disabled until you name your AI provider. On /lab the
    // compose box rendered underneath it, unclickable.
    for (const path of ['/lab', '/lab/worker/abc123', '/lab/harness/deadbeef']) {
      expect(gateAppliesTo(path), path).toBe(false);
    }
  });

  it('still stands on the router surfaces it was written for', () => {
    for (const path of ['/', '/receipts', '/usage', '/settings/keys']) {
      expect(gateAppliesTo(path), path).toBe(true);
    }
  });

  it('is not fooled by a path that merely starts with the same letters', () => {
    expect(gateAppliesTo('/labs-pricing')).toBe(false); // documented: prefix match
  });
});

describe('a failed run says why, in words', () => {
  it('prints the record’s own reason', () => {
    // The exact production case: code ungranted on a new org. The page
    // showed "failed · $0.0000 metered" over two lines reading
    // `returned: superpowerUnavailable`; THIS sentence was in the record
    // the whole time and was never rendered.
    const reason = 'not ready: this worker needs code before it can work. Fix that, then run again.';
    expect(failureReason({ state: 'failed', stateReason: reason })).toBe(reason);
  });

  it('covers every stopped state, not just failed', () => {
    for (const state of ['failed', 'killed-budget', 'killed-operator']) {
      expect(failureReason({ state, stateReason: 'stopped: out of fuel' }), state).toBe('stopped: out of fuel');
    }
  });

  it('says nothing when a run succeeded, or is still going', () => {
    expect(failureReason({ state: 'completed', stateReason: 'done' })).toBeNull();
    expect(failureReason({ state: 'running', stateReason: null })).toBeNull();
    expect(failureReason(null)).toBeNull();
  });

  it('an empty reason is no reason — never an empty red box', () => {
    expect(failureReason({ state: 'failed', stateReason: '   ' })).toBeNull();
    expect(failureReason({ state: 'failed', stateReason: null })).toBeNull();
  });
});

describe('the examples are ready to run, not forms to fill', () => {
  const analyst = GALLERY.find((g) => g.id === 'data-analyst');

  it('the flagship analyst carries no fill-in-the-blank marker', () => {
    // It shipped with a literal `[OPTIONAL FILE URL]`, in the first chip a
    // stranger clicks, with nothing saying to fill it in — and it travelled
    // verbatim into the worker's goal AND its done-definition.
    expect(analyst).toBeDefined();
    expect(analyst!.prefill.goal).not.toContain('[');
    expect(analyst!.prefill.goal.toLowerCase()).not.toContain('optional');
  });

  it('a placeholder that DOES instruct is allowed, and must instruct', () => {
    // The other examples legitimately ask for input — but each one has to
    // tell the reader what to put there, in the imperative.
    for (const g of GALLERY) {
      for (const token of g.prefill.goal.match(/\[[^\]]+\]/g) ?? []) {
        expect(token, `${g.id}: ${token}`).toMatch(/PASTE|NAME|LIST|YOUR|DESCRIBE|HERE/i);
      }
    }
  });
});
