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

## The X-revision (2026-08-28, operator: "100x the capability — extremely useful, highly technically challenging things with ease")

The capability cliff is EXECUTION: everything before X1 makes a worker that
reads and writes prose; the X-ladder makes one that computes. The P-ladder
items not renamed here (beat memory, watchdog, webhook triggers, feedback)
stay and interleave; the X-sequence is the capability spine.

- **X1 — "It computes."** A sandboxed `code` superpower (Python + the
  analyst kit) as a dedicated service on an internal-only network with ZERO
  egress, non-root, CPU/memory/time-capped, per-exec workspace; a durable
  per-run FILE WORKSPACE so files persist across steps and become the
  deliverables (size/count-capped, custody-scanned, rendered on the run
  page, downloadable). Execution slots into the existing checkpoint/replay
  laws as recorded tool steps. Honest posture stated in the machinery:
  container isolation, not VM-grade multi-tenancy — truthful for the
  single-box deploy, revisited before multi-tenant scale.
  *Demo:* "every Monday, pull this public CSV, analyze revenue by segment,
  deliver an xlsx and a chart" — armed, untouched, artifacts with receipts.
- **X2 — "It sustains long missions."** The durable task ledger: the worker
  files a plan through a tool, checks steps off as legs complete, resumes
  exactly where the ledger says, under fuel. Kills the step ceiling
  honestly. Full replay ceremony.
- **X3 — "It proves its work."** The judge (P2) + execution-verified
  contracts: numbers re-computed, generated code's tests actually run
  before completion. "Verified" means RAN.
- **X4 — "It multiplies."** Fan-out sub-runs, one fuel tree, one trace.
- **X5 — "Any tool."** BYO-MCP through full custody.
- **X6 — the honest gap, named: browser-driving.** OpenClaw-types can
  operate a computer: click through web apps, fill forms, drive UIs. After
  X5 our worker reads the web but doesn't drive it, and a fetch tool must
  never be dressed up as a browser. The missing hand is addable as a
  governed superpower — a controlled headless-browser service behind the
  same permission engine, where "click submit on someone else's site" is an
  external action that gates like any other — and it is sequenced as X6,
  after X1–X3 prove out, DELIBERATELY after the judge exists: an agent that
  acts on UIs without self-verification is exactly the kind of
  toddler-with-a-hammer this plan exists to never ship.

Relationship to OpenClaw-types, stated once: the X-ladder builds the
GOVERNED member of that species (same capability class, every hand under
custody law), while `registerPotionGate` harnesses the wild ones — keep
your agent, gain receipts, permissions, and routed inference.

## Course correction (2026-08-28, operator: "will this create the best on the market? if not, correct")

Honest audit against the market across technology / capability / utility /
UX: the X-ladder wins the technology axis (the governed-execution stack has
no peer) and was LOSING the utility axis. Two corrections, effective now:

**1. The Reach track (parallel to the X-ladder).** A worker's utility is
bounded by what it can touch, and two live hands is not a market-winning
answer while the catalog's other connectors sit fixture-authored. In order:
  · **BYO-MCP moves up**: immediately after X3 (was X5). The genius door
    opens the whole MCP world without Potion registering anything.
  · **The OAuth sprint** (operator hands, ~1–2h total): register gmail,
    github, slack OAuth apps; each connector then gets LIVE-PROVEN honestly,
    one at a time — the tier stays earned, never typed.
  · **The mission gallery**: ~10 hire-able templates, each obeying the
    showcase law (promise only what the runtime enforces today).

**2. The supervised loop must actually loop.** A check-in that waits on a
page nobody has open makes born-supervised a polite fiction and blocks every
armed mission on luck. CHECK-IN NOTIFICATIONS ship beside X3: an email the
moment a run goes awaiting-human (answer deep-linked) or a deliverable
lands. Small build, disproportionate honesty.

**Segment claim, stated once:** raw-freedom hobbyists will always prefer an
ungoverned terminal; the market this plan wins outright is DEPLOYABLE
agents — work that is done, provable, budgeted, and safe to leave running.

Revised order: X3 (judge + verified-by-running) + notifications → BYO-MCP →
OAuth sprint + gallery → X4 fan-out → X6 browser (after the judge, as
planned).

## The zero-gaps audit (2026-08-28, pre-X3 — operator: "have user doubts; zero gaps; a step change")

Four skeptics were run against every surface. Six real gaps found; all now
in the sequence. Doubts → answers:

- Founder, "what does it cost monthly?" → **(a) the cost line**: worst-case
  arithmetic on the hire card and worker page (cadence × cap), measured
  actuals beside it once checks run.
- Founder, "what happens when it fails?" → **(b) notification triggers are
  ALL terminal states**: awaiting-human, deliverable filed, failed/killed —
  a worker that failed in the night must be heard about.
- Team lead, "which workers need me?" → **(c) the roster attention strip**:
  awaiting-your-answer · failed-last-check · armable-but-paused, in the
  bench-rail's readiness language.
- Engineer, "prove the replay claim" → **(f) the verify-record button**: a
  server-side replay of any run, zero-divergence result rendered. The
  deepest law becomes a visible wow no competitor can imitate.
- Standing-mission user, "week two it repeats itself" → **(d) P3 beat
  memory re-slotted** to immediately after BYO-MCP (it had drifted out of
  the near order; it is the hero use case's compounding utility).
- Buyer, "artifact retention?" → **(e) hardening item**: stated retention
  window + manual purge for run files (org-delete already cascades).

**The step change, as five user-visible sentences** (each with a surface):
measured decisions with receipts · autonomy earned, never toggled ·
replayable runs you can verify with a button · compute that provably
cannot reach the internet · costs capped by law and predicted up front.

**Locked sequence:** X3 + notifications(all-terminal) + cost line +
verify button → BYO-MCP → P3 beat memory + gallery + OAuth sprint →
X4 fan-out → X6 browser.

## The panel + UX passes (2026-08-28, final pre-X3)

**Panel (distributed systems · security · ML/eval · enterprise · economics).**
No rotten beams. Three GATES bound the "every company" claim, named with
triggers: the SCALE gate (shared rate-limiter store, scheduler leader
election, distributed attempt limiters — before a second replica); the
MULTI-TENANT SANDBOX gate (microVM-class isolation — before hostile-neighbor
tenancy); the ENTERPRISE gate (SAML, residency, SOC2 path, audit export).
Adopted NOW: judge-validity acceptance criteria for X3 (judge ≠ worker's
point where possible; rationale stored; human-agreement sampling before the
judge gates); verify-button wording (replay proves the record is
self-consistent and derivable — never "the model would answer the same");
per-call kind hints from the loop (wrap-up=summarization, judge=evaluation,
plan=reasoning — real routing gain, pennies); timezone-aware cadence (Reach);
per-org armed cap + web-injection threat-model doc (hardening).

**UX (feel · use · maximum value).** Five adopted into the X3 bundle:
worker page leads with the LATEST DELIVERABLE; terminal summary banner on
runs (outcome · cost · duration); deliverables land in the home feed; the
notification answer flow is verified at phone width as an acceptance
criterion; a rename affordance on the specimen header (lawful respec of
the name field).

**X3 bundle, final scope:** judge (rubric-compiled, advisory-until-
calibrated, validity criteria above) + execution-verified contracts +
all-terminal notifications (mobile-verified) + cost line + verify-record
button + the five UX adoptions + per-call kind hints.

## The Heat track (2026-08-28, the final pass — operator: "generational, hottest thing on the market? if no, course correct")

Verdict on the plan as it stood: it builds the most TRUSTWORTHY creator,
not yet the hottest — heat is a different property from excellence. Three
organs added; none bends a law:

- **H1 — the two-minute miracle.** The first check is CHOREOGRAPHED: hire
  from the gallery and the run page becomes a stage — the plan checklist
  ticks live, artifacts materialize, the deliverable unfurls, the cost
  counter stops, the verify badge lands. Real work, beautifully watched;
  nothing faked, everything staged. (Choreography of already-shipped
  mechanisms — the love-at-first-run moment.)
- **H2 — the artifact that escapes.** Opt-in SHAREABLE deliverable pages
  (typeset, custody-scanned, revocable, off by default) footed
  "produced by a Potion worker · $0.04 · record verified ✓" with a
  hire-this-worker link — every forwarded brief is a landing page. The
  verify-proof page shares the same way for engineers.
- **H3 — the breadth proof (operator override, 2026-08-28, standing):**
  "Any agent for any need" IS the positioning — "we are not a specific
  type of agent builder; we are agnostic — and the best at every possible
  agent/harness need." No hero-wedge narrowing, ever. The claim gets hot
  by being PROVEN, not asserted: the gallery is a wall of genuinely
  different agent species — analyst, watchdog, researcher, pipeline,
  reviewer — every one hire-able, every one real under the showcase law
  (breadth is EARNED: entries appear as capabilities land, never ahead of
  them). The landing leads with the universal claim; the escaping
  artifacts (H2) are deliberately DIVERSE so what spreads is
  "it built THAT too?".

Sequence impact: H1 lands WITH the X3 bundle (the judge score and verify
badge are part of the choreography); H2+H3 land with the gallery in the
Reach phase. Boundary, stated once: product supplies the combustible
material — launch moments and distribution are the operator's.

## Final pass verdict (2026-08-28): YES — with one sequencing repair, and the audit is closed

The repair: P5 (the watchdog shape + EVENT TRIGGERS — webhook inlet,
feed-change wakeups) had fallen out of the locked order across successive
re-sequencings. H3's breadth proof DEPENDS on it: different agent SPECIES
need different trigger physics, and a gallery of researcher-flavors proves
nothing. P5 rejoins beside P3 + gallery.

**THE FINAL SEQUENCE (locked, audit closed):**
X3 bundle + H1 choreography → BYO-MCP → P3 beat memory + P5 shapes/triggers
+ gallery + H2 escaping artifacts + OAuth sprint → X4 fan-out → X6 browser.
Gates (scale / multi-tenant sandbox / enterprise) as named.

**Why YES:** substance (computes, sustains, proves, reaches, remembers,
multiplies, drives), trust (every doubt has a visible answer), heat (a
two-minute miracle, artifacts that escape, breadth proven not asserted) —
under laws no competitor can write truthfully.

**The three risks that remain are execution, not plan** — named so they
are watched, not audited again: (1) scaffold maturity compounds with use;
the judge/measurement loop is the machine that closes it; (2) distribution
and launch moments are the operator's; (3) the gates stand before the
"every company" claim widens. Five passes have converged; the marginal
finding is sequencing dust. Further pre-work auditing is theater — the
remaining risk is retired by SHIPPING, not by planning. The next word that
changes this document should be evidence from production.
