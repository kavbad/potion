# G8, answered by machine: judge calibration against deterministic truth

**2026-08-24 · $0.92 live · 18 records in `judge_calibrations` · zero human labels**

G8 left "judge trustworthiness" INDETERMINATE, and the strategy doc gated
capability mixing on judge-scored clusters behind it. The operator asked the
right question — *why can't we automate the judge check?* — and the answer
was that we already had: `runJudgeCalibration` scores a fixed answerer's
real outputs with the deterministic scorer (execution, field-match, exact),
then has each judge re-score the same answers blind, and correlates. The
verdict discipline is the CI95, never the point estimate.

Judges calibrated: **or-judge** (the production judge, sonnet-4.5),
**or-gpt-mini** and **or-gemini-flash** (the strategy-internal judges the
mixing legs use). Answerers: gemini-3.7-flash (varied), inkling-small (weak).

## The three-part result

**1. On code, judges are excellent — CI-defensibly.** Against execution
truth on 30 items: or-judge r=0.994 CI[0.987, 0.999] · gpt-mini r=0.973
CI[0.957, 0.986] · gemini-flash r=0.996 CI[0.989, 1.000]. All three clear
the 0.8 bar on the interval's *lower* bound. mAE 0.008–0.075.

**2. On extraction, the judging CONFIGURATION is the whole story.**
Reference-FREE (what a serve-time confidence check would see): r ≈ 0 with
tiny mAE — the judges scored ~1.0 while truth dipped on partially-missed
fields. **A judge that has not seen the reference cannot detect a small
omission**; that is structural, not noise. Reference-ANCHORED (what our
measurement pipelines — replay judging, the learning period — actually
use): **or-judge r=1.000 CI[1.000, 1.000], mAE 0.000**; gemini-flash the
same; gpt-mini 0.798, underpowered at n=24.

**3. On classification, the question is unanswerable on this instrument:**
every answerer tried — including the deliberately weak one — aced all 30
items, so truth is constant and correlation undefined. Consistent with the
ceiling scan (classification champion at 1.0000). Calibrating judges here
needs harder items, the same debt the capability program hit.

## What closes, what stays open

- **Measurement-side judging is calibrated and trustworthy** where truth
  exists, in the anchored configuration measurement actually uses. The
  judge-scored clusters' measurements stand on published records, not
  vibes. G8's operational core is closed.
- **Serve-time reference-free judging is measured UNSAFE for
  omission-class defects.** Any future shape that relies on a bare judge
  at serve time (judge-pick without execution or references) inherits this
  ceiling — consistent with judge-pick realizing only 27% of oracle
  headroom in the R4 legs.
- **Creative-domain taste transfer remains unmeasurable by construction**
  (no deterministic truth exists there). The mechanism is now proven sound
  everywhere it can be checked; the residual risk is scoped and named, and
  the eventual arbiter is customer preference signals, not operator hours.

## Found on the way

The calibration's first run died instantly on all three suites — the
**third instance of the seed-range bug**: `scoreLlmJudge` derived an
unmasked 32-bit FNV seed per (judge, item, answer), and upstreams reject
seeds ≥ 2³¹. Every live judge call whose triple hashed high had been
failing. Masked to 31 bits (`scorers.ts`); a codebase sweep confirms no
unmasked derivations remain.
