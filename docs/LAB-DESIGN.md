# Potion Lab — the design language (2026-08-26)

**Operator mandate: Lab must look and feel like a generational product.**
This brief records the identity before the build applies it; the redesign
track's laws carry over (day-2-first, restraint, one theater moment, no
decoration without data).

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
