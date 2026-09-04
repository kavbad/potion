'use client';

// THE OUTCOMES INVITATION (2026-09-02) — the fix for the product's deepest
// asymmetry: the Outcome API is the only instrument that can replace a
// judge's opinion with the customer's ground truth, and until now nothing
// in the product ever mentioned it existed. A moat nobody is told about is
// not a moat.
//
// HONESTY RULES, which decide when this renders at all:
//   · It appears only when routing traffic is PROVEN (requests that carried
//     a real routing decision) and the loaded router document carries no
//     outcome evidence on any assignment. Absent data is never treated as
//     absent outcomes — an unloaded router renders nothing.
//   · A floor of MIN_REQUESTS keeps it away from someone's first minute;
//     the ask only makes sense once there is traffic worth explaining.
//   · Dismissible, and the dismissal sticks per browser. This is an
//     invitation, not a nag — a customer who has decided against wiring
//     outcomes should not be asked on every visit.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CopyBlock } from '@/components/copy-block';

/** Below this, the org has not sent enough traffic for the ask to land. */
export const MIN_REQUESTS = 20;
const DISMISS_KEY = 'potion.outcomes-nudge.dismissed';

/** Pure, so the render condition is testable without a DOM: prove traffic,
 * prove the router loaded, and prove no assignment carries outcomes. */
export function shouldInvite(args: {
  routedRequests: number;
  assignments: Array<{ outcomes?: unknown }> | null;
}): boolean {
  if (args.assignments === null || args.assignments.length === 0) return false;
  if (args.routedRequests < MIN_REQUESTS) return false;
  return args.assignments.every((a) => a.outcomes === undefined || a.outcomes === null);
}

export function OutcomesNudge({
  routedRequests,
  assignments,
}: {
  routedRequests: number;
  assignments: Array<{ outcomes?: unknown }> | null;
}) {
  const [dismissed, setDismissed] = useState(true); // assume dismissed until storage is read

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false); // private mode: show it, storage is the convenience not the contract
    }
  }, []);

  if (dismissed) return null;
  if (!shouldInvite({ routedRequests, assignments })) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch { /* private mode — dismissal lasts this session only */ }
  }

  return (
    <div className="mt-10 border border-[#c4bfb2] border-t-4 border-t-ink bg-[#fbfaf7] px-6 py-5">
      <div className="flex items-baseline justify-between font-mono text-[12px] uppercase tracking-[0.14em] text-faint">
        <span className="text-soft">Teach it what good means</span>
        <button type="button" onClick={dismiss} className="text-faint hover:text-ink">
          dismiss
        </button>
      </div>
      <p className="mt-3 text-[14px] leading-relaxed text-soft">
        Your router&rsquo;s quality numbers come from a{' '}
        <span className="font-medium text-ink">judge</span> — a model scoring another model. Your
        application knows better: the query ran, the validator passed, someone accepted the draft.
        Send that back and routing starts optimising for the thing you actually care about.
      </p>
      <div className="mt-4">
        <CopyBlock
          label="One line, where your app already knows the answer"
          text={`await client.outcome(resp.id, { success: true, validator: 'sql_executed' });`}
        />
      </div>
      <p className="mt-3 font-mono text-[12px] text-faint">
        {routedRequests} routed request{routedRequests === 1 ? '' : 's'} measured by judges so far ·
        no verdicts of your own yet ·{' '}
        <Link href="/docs#outcomes" className="text-accent hover:underline">
          how outcomes work →
        </Link>
      </p>
    </div>
  );
}
