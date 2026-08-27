# Potion Lab — the design language (v2, 2026-08-27)

**Operator mandate: Lab must look and feel like a generational product.**

## v2: daylight (what changed and why)

v1 built the Lab as a deep-ink bench — the workshop after hours. The
operator's verdict on the built page was decisive (2026-08-27): *"this
entire page is kind of hard to read cause its so dark, and it does not
look or feel generational."* The lesson is recorded as law:

> **Pages you READ live on paper. Dark is reserved for the instrument.**
> A reading surface on a dark ground reads as gloom, not craft. The one
> legitimately dark element is the organism's viewport (lab-form) — a
> screen SET INTO the paper, the way every serious instrument mounts its
> display. The organism stays the light source *inside its own glass*.

## The identity: one paper house, one dark instrument

- **The whole product is one room now**: warm paper, ink, hairlines, mono
  provenance labels — the Lab uses the same tokens as the ledger and the
  research pages (`ink/soft/faint/line/accent/kept/refuse`, paper cards
  `#fbfaf7` on `#d9d5cb`).
- **The instrument viewport** (lab-form canvas) keeps its own deep ground
  and its policy-derived palette. The shell never borrows the organism's
  tints for furniture; they mean things.
- Lab identity carries in: the specimen mark (hash-hue ring), the trust
  line, the graduation pulse, and the instrument itself — not in a dark
  shell.

## The laws (carried from v1, plus the new ones)

1. **Pixel-to-parameter, everywhere.** Chips, dates, counts, tiers — every
   rendered mark derives from a real parameter. No decoration without data.
2. **Paper stays paper.** The permission ledger, receipts, reports are
   light paper cards — now at home on a light page.
3. **One theater moment: graduation.** The single kept-green pulse on a
   grant (`.lab-graduate`), reduced-motion safe. Nothing else animates for
   drama.
4. **The hire moment is ONE question** — the job in plain words, with the
   refinements quiet beneath it.
5. **Every field explains itself** (operator, 2026-08-27): an InfoDot on
   each hire field, plain-language, truthful to the code (the worth field
   shows its real derived cap live).
6. **Every question the product asks must be answerable where it is
   asked.** A cluster-uncertain draft renders its candidates as clickable
   answers; a missing-evidence gap renders as an honest stop, visually
   distinct, with nothing to answer.
7. **No instant teleports.** Creation renders as the birth sequence —
   staged reveal of the REAL derivation (mission, name, cluster, frontier
   evidence, cap, accounts, supervision), then the operator walks to the
   worker. Pacing is presentation; every line is data.
8. **A newborn page leads with the next step.** "What happens now" (connect
   → trial → answer → earn) renders until the first run exists, with the
   brain-only truth stated before the trial button, not after.
9. **Legibility floor** (house rule 2026-08-26): mono labels ≥ ~12px,
   tracking pulled in when raised.

## The surfaces

- `/lab` — the roster: hire card hero (paper, shadow), specimen cards with
  trust-at-a-glance.
- `/lab/harness/[hash]` — the specimen: identity header, newborn guide,
  the instrument in a framed viewport, permission ledger, connections
  (declared accounts first, honest connectability), OpenClaw wiring card.
- `/lab/run/[id]` — the run seen through the instrument, framed the same.

---

## Appendix: v1 (deep-ink bench, superseded 2026-08-27)

## The identity: the bench and the organisms

Potion is two rooms in one building.

- **The ledger** (the serving product): daylight. Paper, ink, receipts —
  bookkeeping you can trust.
- **The Lab**: the workshop after hours. A deep-ink bench where living
  forms — the workers — are grown, supervised, and graduated. The
  organism's canvas is the light source; the shell stays out of its way.

The two share one bloodline: mono provenance labels, numbers with dates,
refusal rendered as a first-class state, nothing decorative. The ground
inverts; the discipline does not.

**Paper on the bench.** Documents — the permission ledger, receipts,
reports — remain LIGHT paper cards even inside the dark Lab. Paperwork is
paperwork in either room; an organism is never paper. This one contrast
carries the whole metaphor.

## Tokens (the bench)

- Ground `#0b0e14`, raised bench `#10141d`, hairline `#1c2230`
- Text `#c9d2e0`, muted `#8b96a8`, faint `#5c6678`
- The organism owns its own palette (lab-form THEME: policy-derived
  signature tints, asking-pore cyan, anomaly fringes, scars) — the shell
  NEVER borrows those tints for furniture; they mean things.
- Earned-autonomy green `#57d9a3` and refusal `#ff5470` only where the
  data says so (grant states, blocked tiers).
- Type: system sans + the house mono for every label and figure. No serifs.

## The rules (what the audit already enforces, extended to the shell)

1. **Pixel-to-parameter, everywhere.** The form's audit rule extends to
   the shell: every chip, ring, and glow derives from a real field. No
   invented organism visuals in CSS; the shell renders DATA (states,
   counts, dates, tiers) and lets @potion/lab-form render life.
2. **Day-2-first.** A roster with one newborn worker must look like the
   beginning of something, not an empty database: the hire card is the
   hero when the roster is empty.
3. **One theater moment: GRADUATION.** When a human grants autonomy, the
   ledger row crosses from "asks first" to "can act alone" with a single
   kept-green pulse (reduced-motion safe). Nothing else animates for
   ceremony; the form's own motion is measurement, not theater.
4. **No trust scores, no gamification, no progress bars toward autonomy.**
   Evidence counts and intervals only. The absence of a number IS the
   design.
5. **The hire moment is one question.** "Describe the job." Everything
   else is optional refinement; the interview's other slots collapse
   behind it.

## The surfaces

- **/lab — the roster.** "Your workers." Specimen cards: name, kind of
  work, born date, state, and the permission summary (`2 act alone · 5
  ask first · 1 blocked`) as the trust-at-a-glance line. Hire card first.
- **/lab/harness/[hash] — the specimen.** Bench header (name · hash ·
  born · cluster · state), the living form full-stage, the permission
  ledger as a paper document on the bench, the OpenClaw wiring card (the
  copy-paste plugin config with the real harness hash), connectors, runs.
- **Graduation proposals** keep the bar-proposal grammar from the serving
  product — the one-click moment, evidence attached.

## What this design refuses

Fake organism flourishes; scalar trust anywhere; a light-mode Lab (the
bench is dark by identity — it must still hold inside the light app
chrome, as a stage, not a theme toggle); animation as decoration; any
label the data cannot back.
