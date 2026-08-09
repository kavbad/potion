// THE run-twice-diff helper (post-G2.8, promoted from tasks/lessons.md into
// the suite).
//
// THE RULE: for any number that reaches a contract or a customer-facing
// verdict, run the computation twice and diff BEFORE trusting it. A seeded
// estimator proves reproducibility GIVEN its inputs; it proves nothing about
// whether the input selection was deterministic — G2.8 shipped a capstone
// verdict from a single run and only an unrelated second run exposed that the
// interval depended on physical row order.
//
// Lives in @potion/db test-fixtures (the isolation-org precedent) so both the
// db and workers suites share one definition. Packages that cannot depend on
// db (researcher) inline the same three lines rather than import production
// weight for a test helper.
export async function assertReproducible<T>(
  fn: () => T | Promise<T>,
  label = 'contractual computation',
): Promise<T> {
  const first = await fn();
  const second = await fn();
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  if (a !== b) {
    // Name the first diverging offset — a 40-key verdict object diffed by eye
    // is how divergences get waved through.
    let at = 0;
    while (at < Math.min(a.length, b.length) && a[at] === b[at]) at += 1;
    throw new Error(
      `${label} is NOT reproducible: two identical invocations diverged at char ${at} — ` +
        `…${a.slice(Math.max(0, at - 40), at + 40)}… vs …${b.slice(Math.max(0, at - 40), at + 40)}…`,
    );
  }
  return first;
}
