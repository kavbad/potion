# The Harness Build Plan — final pass (2026-08-28)

**Status: the plan of record for Agents/Lab.** Supersedes the W-spine
sketches in conversation; companion to `docs/LAB-DIRECTION.md` (v4, the
harness doctrine) and `docs/INFERENCE-COMPILER.md` (the compiler thesis).
North star, one sentence: **you declare an outcome and constraints; Potion
compiles and governs the inference process that produces it — every decision
from measured evidence, with receipts.** The Lab's job is to make that true
for long-running work, at two depths: an idiot reads a card and gets value; a
genius opens the hood and finds a real runtime.

## How this plan is different from a feature list

Every phase is named by the sentence that becomes TRUE when it ships, and
ends with a **demo that can't lie** — an end-to-end proof performed on
production with no hand on the scale. Surfaces are never the deliverable;
they are how a phase's truth is shown. That is the correction this product
kept needing (the operator's "display toy" verdict was correct), so it is now
structural.

## Global laws (hold for every phase)

1. **The theater ban.** Nothing is ever labeled learned / verified / judged /
   measured unless the mechanism actually ran, is inspectable in the trace,
   and fails visibly when it fails. Where a capability is not yet earned, the
   UI says so plainly (the `fixture-authored` precedent).
2. **The strong column is the moat.** Permissions, custody, observability,
   replay, fences, hard stops, spec tamper-evidence are never weakened to
   ship the weak column faster.
3. **The ceremony.** Every runtime-law change lands with its replay mirror in
   the same commit and regenerated golden corpora (the burn-loop lesson).
   Every new server route ships with its dashboard proxy (the gmail-bug
   lesson). Every surface is reviewed by LOOKING at it in a browser in its
   real states before deploy.
4. **Two depths, one object.** Every phase must name what the idiot sees and
   what the genius finds; if either answer is weak, the phase is not done.
5. **Metered like everything else.** Workers run on the org's own serving
   path (`potion-auto`) at the same metered economics; judges, verifiers, and
   escalations are steps under the same fuel laws, never free riders.

## The proof ladder

### P1 — "It did a real job while you slept."
The three missing organs — hands, clock, mouth — shipped as ONE proof,
because separately they are features and together they are the product.

- **Hands: the `web` superpower** (first live-proven catalog entry). HTTP GET
  + RSS/Atom parsing. Laws: SSRF-blocked (no private ranges, no redirects to
  them), response size and time caps, per-run and per-tool call caps
  (existing `maxCalls`), content extraction to text, robots restraint,
  custody scan on everything fetched before it enters context, metered.
  Read-only by construction — there is no write verb in the package.
- **Clock: the standing scheduler.** New mission state: `armed | paused`
  (born paused; arming is an explicit operator act — a trial stays a trial).
  Armed standing missions start one check per cadence window under
  `maxUsdPerDay`; missed windows do not burst (skip, note, move on); fences
  prevent overlapping checks; kill switch pauses instantly. Full ceremony:
  replay mirror + goldens.
- **Mouth: output contracts, v1 = `brief`.** "It should produce…" compiles
  to a typed contract (headline items each carrying a source URL; a by-entity
  section; a "checked but quiet" section). The contract is schema-checked
  before a run may complete; the run page renders the deliverable FIRST,
  accounting beneath; completed checks land in the feed.

**Demo that can't lie:** hire the showcase worker on prod, arm it, touch
nothing. Next morning there is a brief built from real pages, every claim
carrying its source, every step receipted, cost under cap.
Idiot: reads the brief. Genius: clicks from any claim to its fetch in the
trace, and from the trace to the spec's contract.

### P2 — "It knows whether its own work was good."
The measurement religion applied to the worker's craft. The rubric is
compiled at build time from "done well means…" + the pasted example, is part
of the spec (visible and editable in the machinery), and a judge pass scores
every deliverable against it — a metered step under fuel. Scores chart over
time on the worker's page; regressions surface in the feed. v1 the judge is
advisory (never blocks completion) and says so; it becomes a gate only after
calibration — the G8 judge-calibration discipline, reused. This phase is the
keystone: nothing later (escalation, feedback, learning) can be honest
without it.

**Demo:** two runs, one deliberately degraded (constrain sources); the chart
shows the dip and the feed names it.
Idiot: "your worker scored 8.4 against your bar." Genius: the rubric text,
the judge trace, the calibration status — all inspectable.

### P3 — "It remembers its beat."
Structured working set replaces blob memory for standing missions: entities
(first seen, last seen, history of claims about them), per-source stats
(yield, staleness, failures), dedup keys that ENFORCE "no repeats across
days" instead of hoping for it. A short reflection note per run — what
worked, what was dry — labeled as the worker's own notes, fed into the next
check's context. The memory page becomes a readable ledger of what the
worker knows, editable and deletable (existing memory laws).

**Demo:** the same story appearing in two feeds on two days is reported
once; the trace shows the dedup hit. "Northwind" has a history, not a
snapshot.

### P4 — "It verifies before it asserts, and thinks harder when it must."
- **Claim binding:** load-bearing claims must carry a source or be flagged as
  unverified — the contract validator enforces it.
- **Verify pass:** before completion, load-bearing claims re-checked against
  their sources; failures downgrade or drop the claim, honestly.
- **Partial honesty:** "covered five of six companies; TechCrunch was down"
  is a first-class completion state, rendered as such.
- **Escalation law:** a verify failure or low judge score triggers ONE retry
  of the failing step at a stronger operating point on the frontier, within
  fuel. This is the first place harness strategy visibly rides measured
  evidence — the escalation target is chosen from the same curve the router
  serves from. Ceremony applies.

**Demo:** poison one source (a claim its page doesn't support); the brief
ships without the claim and the trace shows the verify kill.

### P5 — "A second shape that isn't a researcher." (the axes become real)
The **watchdog**: mostly silent, fires only on a true condition. Different
law, not different adjectives — its judge measures precision and
false-alarm rate; "nothing worth your attention — 14 sources checked" is a
valid, judged deliverable; its contract is the alert. With it, **event
triggers**: a webhook inlet (anything can poke a worker awake) and
feed-change triggers built on P1's web hands. The recipe card gains its
first real shape choice, named in plain words.

**Demo:** a watchdog on a pricing page stays silent for days, then fires
within one cycle of a real change — with the diff as evidence.

### P6 — "The genius door." 
- **BYO-MCP:** register your own MCP endpoint as a superpower, through the
  FULL custody path — scopes, secret refusal, before-external-action,
  per-tool caps, metering, grant/revoke. Closed catalog becomes open world;
  "valuable for any need" starts being literally true.
- **Contract `json`:** user-supplied output schema, validated.
- **Delivery `webhook`:** deliverables pushed to the operator's systems
  (gated by the permission engine like any external action).

**Demo:** an engineer wires a worker to their own MCP server and their own
schema without talking to us, and the permission ledger governs it.

### P7 — "It learns from you."
Feedback on deliverables becomes evidence, the way approvals on actions
already are: act / edit / dismiss per item, distilled into durable
preference rules — visible in the machinery, attributed ("learned from your
edits, 2026-09-xx"), revocable. Weeks of use compound into a worker nobody
could hire off the shelf; the personalization moat, same story as the router.

**Demo:** dismiss crypto items three days running; day four's brief
deprioritizes them and cites the learned rule — which you can delete.

### P8 — "It multiplies."
Fan-out: a check decomposes into bounded sub-runs (one per entity), each
routed by its own kind of work — the router shining per sub-task — then a
synthesis pass; parent fuel bounds the whole tree; one tree, one trace.

**Demo:** six companies researched in parallel sub-runs, six receipts, one
brief, wall-clock a fraction of the serial run.

## Unlocks that slot in anytime (not dependencies)

- **Gmail live OAuth** (~20 min of the operator's hands in Google Cloud):
  after P1 it makes inbox missions real; after P6's delivery laws, sending
  drafts becomes possible under earned permissions.
- **Search API key** (operator choice): P1 works on fetch+RSS alone; a
  search key widens discovery.
- **The long arc** (research engine): the same instrument that ranks recipes
  on the frontier will rank harness strategies (verify on/off, ensemble,
  decompose) per kind of work — making "compiled from evidence" literal one
  level up. Begins after P4 exists to generate the data.

## What we are NOT building (so the plan stays a blade)

No agent marketplace. No multi-provider BYOK. No free-form chat-assistant
shape (a different product; revisit only after P8). No autonomy sliders —
autonomy stays earned, never configured. No simulated activity, no fake
progress, no "AI magic" labels on deterministic code. No new pricing —
workers ride metered serving.

## Sense-check gates

After P1 and after P4, the operator walks through as a user and passes
verdict before the next phase starts. Any phase's demo failing on prod
stops the ladder until fixed — demos are the contract, not the UI.

## Sequencing note

P1 is deliberately the biggest bite (three organs, one proof) because its
demo is the product's existence proof; everything after it ships alone and
compounds. P2 before P3/P4 because measurement precedes improvement,
always. P5 before P6 so the genius door opens onto a multi-shape runtime
rather than a single-shape one.

## The showcase law (added 2026-08-28, operator review)

The recipe card's example is part of the product's claim surface, so it
obeys the theater ban like everything else: it may only promise what the
runtime can enforce TODAY. Corollary: every phase's definition-of-done
includes RE-CHOOSING the showcase to exercise the new capability — after
P3 it promises "only what's new since yesterday"; after gmail it reads the
operator's actual inbox; after act-verbs it drafts and files under
supervision. The example sits exactly at the product's frontier, never
behind it and never ahead of it. Until then, the honest answer to "a chat
app could do this" is: as output, yes — as an unattended, budgeted,
contract-checked, receipted operation, no — and the gap becomes unfakeable
phase by phase rather than argued.
