# Potion Research — operations runbook (v1, 2026-09-02)

**Status: the F-ladder's operating manual (F0–F7 shipped).** The fleet doctrine is
`docs/RESEARCH-FLEET.md`; the writing standard is
`docs/RESEARCH-WRITING.md`; this is how the weekly loop actually runs.
Built F0–F2 (2026-09-01/02): Delta writes in a recorded run, Auditor
independently verifies, four deterministic guards screen every draft, and
publication passes the Action Gateway — born supervised, earned per the
grant ledger.

> **2026-09-11 — the weekly full run is retired.** The weekly script
> (`observatory-week`, deleted: canaries + auditions + digest + the Monday
> artifact) is gone. The only
> clocked measurement is now the provider-drift tripwire
> (`packages/workers/src/drift-canary.ts`, scheduled weekly by the server as
> the `drift:canary` job; `scripts/drift-canary.ts` runs it once from a shell
> and is what the compose `observatory` profile now executes). On drift it
> retires that model's cells and the learning period re-measures through the
> proposal path. The week's run record (`artifacts/runs/<week>.json`) is
> materialised by the server's Monday tick from two ledgers — `drift_canaries`
> and `learning_proposals` — so Frontier Notes read the proposal ledger, not a
> script's output. The host cron `/etc/cron.d/potion-observatory` can be
> removed; if left, it runs the tripwire, which is idempotent per ISO week.

## The rig (org-research, on prod)

- Org `org-research` ("Potion Research"), user `user-research-ops` —
  created by `scripts/research-org-rig.ts` (re-run mints a fresh
  `POTION_LAB_SESSION`; needs `DATABASE_URL` from `.env.prod`).
- Gate key: `scripts/research-key-mint.ts` → `POTION_RESEARCH_KEY`
  (rotates on re-run).
- Workers (hire scripts re-create deterministically; DIAL each new hire):
  - Delta: `scripts/delta-hire.ts` → hash, then
    `POST /api/lab/harnesses/<hash>/dial {"slot":"brain","qualityIndex":2}`.
  - Auditor: `scripts/auditor-hire.ts` → hash, then the same dial.
  - Rung 2 is the proven spot; rung 3 was a slow reasoner that
    hollow-completed.
- Current generations (2026-09-02): Delta v6 dialed `8aec3d6c…`,
  Auditor v4 dialed `03ba2065…`.
- Daily generations (committed compose defaults since 2026-09-10): piece
  writer `08a81fd4…` (`scripts/delta-piece-hire.ts`), piece verifier
  `a8ae19dd…` (`scripts/auditor-piece-hire.ts`, hired 2026-09-05 — it sat
  UNWIRED for five days: compose defaulted the env to "" and `?? null`
  kept "", so the clock started a run on harness "" every 60s and four
  Delta dailies stood unverified. Blank is now absent, in the clock and
  in the env read.) Not yet dialed: rung 0–3 all resolve to the same
  strategy on its frontier, so dial when convenient and promote the hash.

## The weekly ceremony

**Monday — measurement (existing, still manual).** The observatory run
produces `/opt/potion/research/artifacts/runs/<WEEK>.json` on prod.

**Tuesday — draft, verify, gate.** From a repo checkout with a store copy
(`ssh root@178.105.98.174 'tar -C /opt/potion/research -czf - store-copy' | tar -C <dir> -xzf -`):

```bash
OBSERVATORY_DB=<dir>/store-copy OBSERVATORY_ARTIFACTS=<dir>/artifacts \
WEEK=<YYYY-Www> DELTA_HARNESS=<delta> AUDITOR_HARNESS=<auditor> \
POTION_LAB_SESSION=<ps_…> POTION_RESEARCH_KEY=<pk_…> \
POTION_LAB_URL=https://api.withpotion.com DELTA_TIMEOUT_MS=480000 \
npx tsx scripts/frontier-notes-week.ts
```

The chain: Delta run drafts from a REDACTED fact sheet (vague savings
removed) → count audit → style lint → vague-ratio guard → Auditor run
verifies (typed record; no verdict = fail for model prose) → publish
gate. Every failure falls back down the chain and the note still writes —
model prose never ships unverified, and the note is never blocked.

**The publish gate (F2).** While the `publish_frontier_notes` grant is
supervised the issue lands `held` with the supervisor question. Approve
the exact draft (fingerprint-bound), then release:

```bash
DATABASE_URL=<prod> NOTES_DIR=<dir>/artifacts/notes WEEK=<YYYY-Www> \
POTION_RESEARCH_KEY=<pk_…> DELTA_HARNESS=<delta> \
npx tsx scripts/frontier-notes-release.ts
```

Release re-checks the SAME content hash — an edited file voids the
approval. Approvals and clean outcomes accumulate on the grant ledger
(`GET /api/lab/harnesses/<delta>/grants`); when the graduation pass
proposes autonomy, **accepting it is the operator's click**
(`POST /api/lab/grants/<id>/accept`) — never an agent's.

**Publish to the site.** The dashboard serves
`/opt/potion/research/artifacts/notes` (read-only mount,
`deploy/docker-compose.prod.yml`). Copy the released files:

```bash
scp <dir>/artifacts/notes/<WEEK>.json <dir>/artifacts/notes/<WEEK>.md \
  root@178.105.98.174:/opt/potion/research/artifacts/notes/
```

Then verify `withpotion.com/research/<week>` renders the byline, the
run-record box, and the verification line.

## Surfaces (F3)

- Author pages: `/research/authors/<slug>` — identity from
  `apps/dashboard/lib/research-authors.ts`, every number derived from the
  published issues (run ids, verification records, counts).
- Glossary: `/research/glossary` — the canonical definitions (E6);
  articles link, never redefine. Held/drift carry the ONE-SIDED law
  (`observatory.ts` `driftVerdict`: collapse-only).
- CTAs: `apps/dashboard/lib/research-ctas.ts` — a CTA resolves to a LIVE
  surface or it does not exist (E7).

## The daily ledger (F6 — live, Delta-framed)

**PROVEN 2026-09-04**: `/research/2026-09-04` published autonomously,
byline **Delta**, framing run `run-c244a0c0`, every number from the
code-composed ledger. Four defects were found getting there, each only
visible by reading the published artifact (never by a green build):
the lane WEDGED on a parked framing run (`awaiting-human` was not
terminal — no daily would ever have posted); the first publish was HELD
because the ledger printed the prices append-log carrying withheld
aliases; a read-after-write race read `daily.json` 889ms after the run
completed and saw nothing; and `parseDraft`'s three-FAQ rule made the
Delta byline structurally unreachable on a format that has no FAQ.


`dailyLedgerTick` runs on the same 60s clock, once per UTC day: it
composes the day's facts from `research_cycles` and `recipe_status`
(24h window), starts ONE Delta framing run, and publishes
`<YYYY-MM-DD>.{json,md}` into the notes dir. The framing is an
improvement attempt, never a gate — a refused framing (THE NUMBER LAW,
or no `daily.json`) publishes the code-composed ledger instead, so the
day is never missed. A daily needs no gate ask: its content is
code-composed and the publish grant covers the class.

## The clock (F4 — live)

The Tuesday chain runs INSIDE the server: a 60-second tick
(`apps/server/src/research-clock.ts` wiring
`frontierNotesTick`/`clock.ts` in @potion/workers) that, from Tuesday
06:00 PT, watches for `artifacts/runs/<week>.json` and drives
draft → guards → verify → gate → land, one small durable step per tick
(state in `artifacts/fnotes-state/<week>.json`). Bounded draft attempts;
on exhaustion the deterministic draft ships through the same gate — the
note always lands, model prose never lands unverified. A gate-held issue
self-releases when the operator's recorded approval appears (or the
grant is autonomous). Armed by four env vars in `.env.prod`
(`POTION_RESEARCH_DIR=/research`, `POTION_RESEARCH_ORG=org-research`,
`POTION_RESEARCH_DELTA_HARNESS`, `POTION_RESEARCH_AUDITOR_HARNESS`) +
the `/opt/potion/research:/research` rw mount (compose). Manual trigger
and status: `POST/GET /api/research/frontier-notes` (admin; POST takes
`{week?, dir?}` — a `dir` under the mount runs a full REHEARSAL chain
without touching the public notes). The tick never blocks the queue (one
worker, concurrency 1 — a waiting job would deadlock it; the clock is an
in-process tick like the reaper). Update the harness env vars when a new
generation is promoted.

## The roadmap (operator-directed, 2026-09-03)

- **F5 — automate Monday — SHIPPED (55076e7), REWIRED 2026-09-11**: the
  Monday tick used to RUN the weekly script inside the server container;
  it now MATERIALISES the week's run record from the `drift_canaries` and
  `learning_proposals` ledgers (the tripwire itself is the server's weekly
  `drift:canary` job), so the money path is never duplicated. **DISARMED unless
  `POTION_OBSERVATORY_ARM=YYYY-MM-DD`** is set in `.env.prod` — the same
  dated risk-acceptance the script demands by hand, deliberately not
  defaulted in compose. One run per ISO week (exclusive `wx` marker +
  run-file guard; a non-zero exit clears the marker so a failed week
  retries). Never a queue job — a long measurement would starve the
  fleet's own `lab:run` legs at concurrency 1. `FRONTIER_NOTES_SKIP=1`
  stops the script publishing its own note: it used to write the week's
  issue via the OLD one-shot path, which would have preempted
  Delta/Auditor/the gate. Trigger:
  `POST /api/research/frontier-notes {"measure":"dry"|"run"}` (dry plans
  without spending); `GET` reports arm state and any running measurement.
  **ARMED on prod 2026-09-04 by operator order** (`POTION_OBSERVATORY_ARM=2026-09-04`
  appended to `.env.prod`, backup `.env.prod.bak-202609040447`). First
  automated measurement: **Monday 2026-09-07, 06:00 PT** (W37). Expected
  spend ≈ $8/week (10 canaries $2 + 3 auditions $6) inside the $50
  monthly envelope. Belts verified live at arm time: the week guard
  refused a real `run` for an already-measured week, and a `dry` spawn
  succeeded while creating no week lock. **To disarm: remove that line
  and recreate the server.**
- **F6 — the daily cadence — SHIPPED (05026b3)**: `dailyLedgerTick`
  runs beside the weekly on the same 60s clock. The daily UNIT is the
  ledger of what the instruments did in 24h (cycles, candidates swept,
  aliases measured, promotions, spend), composed BY CODE from the day's
  rows — true by construction, so a quiet day publishes a short quiet
  ledger and never a manufactured finding. The model writes only the
  framing; THE NUMBER LAW (`auditDailyNumbers`) refuses any figure not
  in the ledger and any derived ratio outright. Files land as
  `<YYYY-MM-DD>.json` beside the weeks. If the framing is refused the
  deterministic ledger ships — the day is never missed.
- **F7 — the reading experience — SHIPPED (05026b3)**: /research is an
  editorial magazine — featured issue, live DAILY LEDGER rail, a "why
  these numbers are different" band, archive grid with kind tags and
  linked bylines. Structure borrowed from review.firstround.com; the
  standing design law held (no serif, mono labels ≥12px, ledger
  masthead kept).
- **The done-verifier law — SHIPPED (05026b3)**: a task whose
  doneDefinition names a deliverable file the run does not hold cannot
  complete, even on a stop that names nothing (`doneFileRepair`, one
  round, replay-mirrored). Platform-wide, not fleet-only.

## The loop, closed

Monday measures (F5, when armed) → Tuesday drafts, verifies, gates and
publishes (F4) → every day files a ledger (F6) → the magazine renders it
(F7). No operator machine is in the loop for any of it; the operator's
remaining levers are the arm date, the standing grant, and the veto.

## Laws grown from published pages (2026-09-04)

Three defects that only reading the published artifact could find. All
three passed every test and logged success.

- **A name is not a claim.** The piece number law read the "4.6" in
  `grok-4.6` as an invented figure and refused the draft (`run-0a9de197`).
  Because every piece worth publishing names its models, the writer lane
  was effectively dead and the composed fallback published *every day* —
  the logs said "writing refused / the composed piece publishes", which
  read like a rare safety net rather than the daily norm it had become.
  Names are now stripped before figures are read.
- **The routing prefix is ours.** `or-` addresses the provider inside
  Potion's catalogue. `publicName()` passed it straight through, so the
  page printed `or-grok-4.6`. It now prints the model, not the config.
- **The own-spend law had to reach the page, not just the draft.** The
  provenance footer published `$0.0031 metered` — our own writer bill,
  under every piece. The draft lint could not see it because the
  *template* wrote it. `writeIssue` now runs the law over the rendered
  markdown and holds the issue if it trips.

Two more the same day, both the same mistake in the other direction — a
law reading OUR OWN output as if the model had written it:

- **The late writer** (`run-d21f0a1b`). The writer's run did 95 seconds of
  work after sitting **29 minutes** in the queue (one worker, concurrency
  1). The 20-minute framing deadline was measuring queue latency, calling
  it a slow writer, publishing the composed fallback and binning a
  finished draft. Now: the day is filed on time AND the writer's prose
  replaces it when the run lands (phase `awaiting-writer`, 6h ceiling).
  Late is not wrong; only wrong is wrong. The draft is judged against the
  assignment it was handed — carried on the state file — so a measurement
  landing while it was queued cannot make its correct numbers look
  invented.
- **The footer is not a claim.** The piece number law scanned
  `auditionNote`, which both publish paths overwrite with the
  code-composed measurement footer, and refused every draft on the "24" in
  "the last 24 hours". Found by the late-writer TEST, not by reading code:
  a manual check of the same draft passed because it fed the raw
  `piece.json` without the footer merged in.

The general rule this keeps proving: **a guard that only sees the model's
output cannot see what the code around it prints — and a guard that reads
what the code printed as if the model wrote it is the same error mirrored.**
Lint the artifact, and check the artifact the way production assembles it.

## The second-paragraph law (2026-09-05)

The first Delta-written daily (`run-5834835a`) said the same four numbers
three times. **The writer was following orders.** The assignment asked
`plain` for "what was compared, what the gap is" and then asked `lede` for
"the key numbers with their sample size" — the same paragraph, ordered
twice. It also asked for `frontierNote`, which `assemblePieceIssue` never
publishes.

The three published paragraphs now have three jobs, named as such in the
assignment: **the finding, what it means, what to do.** The middle one is
told not to restate the figures.

A prompt is a wish, so the law makes it a rule (`auditRepetition`): if the
second paragraph carries three or more figures and every one already
appeared in the first, it is paragraph one again and the piece is refused.
Referring back stays legal — "the extra 8.7 points" earns its place in an
argument; restating the set does not. A sentence repeated across
paragraphs is refused anywhere.

Two notes on scope. It is **daily-only** — the weekly's `plain` and `lede`
have jobs of their own and have not shown this failure; widening it is a
separate change needing its own evidence. And a test runs it over every
candidate the agenda can produce, which immediately caught the *house*
prose breaking it: the `cheapest-at-floor` fallback restated its own price
range. **A law the fallback violates would refuse the writer for a fault
we ship ourselves.**

Harness: `80eec64c72fb9912eca5aeded94fe63a2f641af9ff060d50e8d05f88a691affc`
(supersedes `457870b2…`; dialed via `POTION_RESEARCH_DELTA_DAILY_HARNESS`
in the host `.env.prod`, which is runtime truth and never rsynced).

## Filed follow-ups
- **runx- sessions on the dashboard run route**: the gate session's
  recorded resolutions are read via `DATABASE_URL` by the release script
  because `GET /api/lab/runs/:id` rejects the id shape; serve them.
- Stray pre-fix W36 copies sit in the unused `/opt/potion/research/notes/`
  — remove at leisure.
