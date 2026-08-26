# Frontier Notes — the weekly research publication

**What it is.** Every Monday, after the Observatory's weekly run and the
mixing lane's replay pass, Potion publishes one issue of *Frontier Notes* at
`withpotion.com/research`. It is written by a model from the week's
measured artifacts, checked by a deterministic redaction pass, and goes live
without a human in the loop (operator decision 2026-08-22; a review gate can
be switched on with `FRONTIER_NOTES_GATE=1`, which holds the issue as a draft
and posts the draft link to Notion instead).

**Why it exists.** To own the category "measured model routing" in search and
in answer engines — the place you land when you ask *which model is cheapest
for classification this week*, *do small models beat frontier models on
extraction*, *what is a routing frontier*. Every issue is real measurement,
dated, with intervals, which is what makes it citable.

**Name.** *Frontier Notes* — the Pareto frontier is the object the product
measures, "notes" promises cadence and brevity, and the phrase is searchable
without being generic ("Measured") or cute ("The Cauldron").

## The contract: what an issue may and may not say

### May say (this is the product, and it is what makes an issue worth reading)
- Cluster-level findings with numbers: quality, 95% interval, cost per 1,000
  requests, p95 latency — for any model on the PUBLIC roster (the names the
  landing page and docs already print).
- Drift verdicts: which clusters held, which moved, by how much.
- Audition outcomes for named public models: measured, and whether it earned
  a frontier slot — stated as "did not beat the incumbent on this work".
- Counts of what was measured (items, clusters, candidates, dollars).
- Mixing findings described by EFFECT: "a two-call combination matched the
  strong model on extraction at 38% of its cost" — cluster, quality, cost.
- Method at the level the docs already explain: suites are retrieval-hostile,
  code is scored by execution, intervals are bootstrap, frontiers are
  three-dimensional Pareto sets.

### Must not say (the moat)
- Any name on the NEVER-NAME list (`packages/workers/src/frontier-notes/
  redact.ts`), nor a description that identifies it (vendor, country,
  parameter count, release date, "the Korean lab's model").
- Which models a mixture combines, in what order, with what thresholds,
  votes, or gates — no program bodies, no strategy hashes for composites.
- Confidence thresholds, cascade cut-offs, judge models, judge prompts, item
  text, or anything that would let a reader reproduce a suite.
- Frontier membership as a list ("the current frontier for X is A, B, C").
  A single public model's point is fine; the set is the product.
- Spend beyond the week's round number.
- Anything about customers, partners, or traffic.

### Breakthrough rule
If the week produced a frontierCandidate or cheaperAndAsGood finding from the
mixing lane, the issue reports the cluster, the quality (with interval), and
the cost ratio — and says only that it came from "a combination of
measured models". No mechanism name, no component names. If the finding is
large enough that even the cluster + ratio would be a giveaway, the
generator's `vagueness` flag widens it to a band ("between 2× and 4×
cheaper") and drops the cluster to its family ("structured-output work").

## Issue anatomy (fixed, so readers and crawlers learn the shape)
1. **Title** — a finding, not a label. "Small models held on classification;
   a combination matched the strong model on extraction at 38% of its cost."
2. **Lede** — three sentences: what was measured, the one finding, the caveat.
3. **This week's frontier** — table: cluster · held / moved · cheapest public
   point at the 0.95 floor (model, quality ± ci, $/1k) · change vs last week.
4. **Auditions** — each public candidate measured: cluster, quality ± ci,
   $/1k, outcome, one sentence on why.
5. **Mixing** — effects only, per the breakthrough rule.
6. **Method note** — the same 120 words every week, so the claim is always
   accompanied by how it was measured.
7. **Numbers** — canaries run, items graded, candidates, dollars.
8. **Glossary line** — defines "frontier", "floor", "interval" for answer
   engines, linking to the docs.

## AEO / SEO
- Route: `/research` (index) and `/research/<yyyy>-w<ww>-<slug>` (issue).
  Static-rendered, no auth, canonical URLs, `<title>` = issue title ·
  Frontier Notes.
- JSON-LD: `Article` (headline, datePublished, author = Organization
  "Potion Research", publisher Potion / Mutiny, about = "model routing"),
  plus `Dataset` for the week's measurement table (name, temporalCoverage,
  variableMeasured) — answer engines lift tables from Dataset markup.
- `FAQPage` block at the end of every issue with three evergreen questions
  answered from that week's numbers ("Which model is cheapest for
  classification at 95% quality this week?").
- RSS at `/research/feed.xml`; `sitemap.xml` lists every issue; `robots.txt`
  allows `/research`.
- Internal links: every issue links the docs' glossary and the landing
  evidence band; the landing footer and header link "Research".
- Voice: plain, declarative, numbers first, intervals always, no superlatives
  the measurement does not support. British understatement beats hype for
  citation.

## Pipeline
`scripts/observatory-week.ts` → run JSON + replay findings →
`frontier-notes/compose.ts` (deterministic fact sheet: only public names,
only permitted fields) → `frontier-notes/write.ts` (LLM drafts from the fact
sheet ONLY — it never sees raw artifacts) → `frontier-notes/redact.ts`
(deterministic: never-name list, composite hashes, threshold numbers, item
text; any hit fails the issue closed) → `research_issues` table (draft →
published) → Notion line with the URL.

The writer is a measured model from the public roster; its cost is part of
the Observatory envelope and ledgered like every other dollar.
