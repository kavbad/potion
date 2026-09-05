// WHICH NUMBER LEADS THE ROUTER PAGE, and why it is allowed to.
//
// The history matters, because this rule has been reversed once and the
// reasoning has to survive the next reversal:
//
//   2026-09-01 — the hero was dollars kept. The operator rejected it twice
//   ("i still dont think thats right"). The objection was not the rounding;
//   it was that a big dollar figure describes money never committed. It was
//   replaced by the house ratio ("1/270th the price of the best scorer").
//
//   2026-09-04 — the operator asked for the money back: "i dont want it to
//   say 1/60th anymore, i want it to say the $amount saved."
//
// Both are right, about different situations, and the thing that separates
// them is WHAT THE BASELINE WAS MEASURED AGAINST. usage/current's
// baselineCostUsd is "the model the org designated for that kind of work
// where it is on the frontier, ELSE the highest-quality point" — so:
//
//   · incumbent NAMED  → the baseline is a model the customer actually ran.
//     The difference is real money they would have spent. Lead with dollars.
//   · incumbent UNNAMED → the baseline is the premium pick, which most
//     customers were never going to buy. "$847 saved" against a model you
//     would not have bought is the 2026-09-01 objection restated. Keep the
//     ratio, which is honest about being a comparison rather than a receipt.
//
// The remaining gap, and it is deliberate: baselineCostUsd mixes bases across
// clusters (designated where designated, premium elsewhere) and the DTO does
// not say which was used per cluster. Until it carries that basis field, "has
// this org named ANY incumbent" is the best available proxy, and it errs
// toward the ratio — the conservative side.

export type HeroMode = 'dollars' | 'ratio' | 'kept-only';

export interface HeroInput {
  /** What the org actually spent this month. */
  actualSpend: number;
  /** What the same traffic would have cost on the baseline point. */
  baselineSpend: number;
  /** Models the org named as what it uses today. */
  incumbentModels: readonly string[];
  /** A free-text incumbent, when the org's model was not in the roster. */
  otherIncumbent?: string | null;
}

export interface HeroDecision {
  mode: HeroMode;
  /** What the baseline should be CALLED in the sentence beside the number. */
  comparator: string;
  /** True when the org has told us what it runs today. */
  namedIncumbent: boolean;
}

export function heroDecision(input: HeroInput): HeroDecision {
  const { actualSpend, baselineSpend, incumbentModels, otherIncumbent } = input;
  const namedIncumbent = incumbentModels.length > 0 || !!otherIncumbent;

  const comparator =
    incumbentModels.length === 1
      ? incumbentModels[0]!
      : incumbentModels.length > 1
        ? `the ${incumbentModels.length} models you named`
        : (otherIncumbent ?? 'the best scorer');

  // Nothing to compare against, or nothing spent yet: the kept counter is the
  // only honest thing on the page, and it is allowed to be $0.00.
  if (!(baselineSpend > 0) || !(actualSpend > 0)) {
    return { mode: 'kept-only', comparator, namedIncumbent };
  }
  return { mode: namedIncumbent ? 'dollars' : 'ratio', comparator, namedIncumbent };
}
