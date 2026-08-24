# The first vision frontier (G phase 1 — 2026-08-23)

## The instrument

`extraction-vision-v1`: 16 PIL-rendered documents — invoices, receipts,
signs, tables, labels, meters — every field objectively in the pixels,
scored by deterministic field-match. No judge anywhere near this axis.

## The leg ($0.26 total, inside the envelope)

| strategy | quality (16 items) |
|---|---|
| or-gpt-full | **1.000** |
| cascade(or-inkling-small → or-gpt-full) | **1.000** |
| or-gemini-3.7-flash | 0.979 |
| or-inkling-small | 0.979 |
| or-kimi-k3 | 0.958 |
| or-grok-4.6 / or-sonnet | 0.938 |
| or-gemini-flash / or-gpt-mini | 0.917 |
| or-solar-pro4, or-deepseek, or-kat-coder | contained: "no endpoints support image input" — capability discovered by measurement, not claimed |

Published frontier (`extraction`, instrument `vision`, v1, six points):
gpt-mini $0.24 → inkling-small $0.45 → gemini-flash $0.65 → gemini-3.7 $0.83
→ **cascade $0.90 @ 1.000** → gpt-full $1.16 @ 1.000.

## Verified live

A never-seen invoice image through the public OpenAI-compatible API:
classified on its text view, served from the vision frontier under
max-quality — answered by **the cascade** (`x-potion-model:
combination:cascade`, trace `instrument=vision`), every field correct.
Unlike function calling, where cascades lost, **on vision the cascade is
frontier-optimal**: perfect quality at 78% of the best single's price.

## The bug the leg caught

The first publish returned nothing: a cell's instrument derived from its
*scorer*, and vision items are field-match → the cells landed as `default`,
invisible to the vision aggregation and polluting extraction's text axis —
the same contamination class the instrument dimension was built against.
The instrument now comes from the leg (`runEval` stamps it; scorer
derivation is legacy fallback); migration 0049 retagged the cells.

## What serving does now

Image parts are accepted when the resolved cluster has a measured vision
frontier and refused with the cluster named when it does not. The images
never enter classification or the learning sampler — both read the text
view. Next modalities ride the same rails: an instrument, a leg, a frontier.

## Phase 2 (same day): charts, panels, document types

Two more instruments on the same rails, $0.23 for both legs:

- `rag-answer-vision-v1` (12 rendered bar charts and status panels, the
  asked value printed in the pixels): seven models perfect; inkling-small
  and the cascade at 0.917. Frontier: **gpt-mini alone** — perfect and
  cheapest ($0.21/1k).
- `classification-vision-v1` (12 documents across six types): a clean sweep
  — every candidate 1.000 including the cascade. Frontier: gpt-mini
  ($0.22) + gpt-full (surviving on the latency axis).

`supports_vision` now lives on the registry, set only from vision-instrument
evidence (migration 0050); `capabilityFilter.vision` excludes unknowns.

Live probes: a fresh chart answered 1610 for W3 (served by the cascade,
`instrument=vision`); a fresh boarding pass typed and its gate read
(gpt-mini). Three clusters serve vision; an image landing anywhere else
still gets the honest refusal naming its cluster.

## Phase 3 (same day): screenshots → code

`code-gen-vision-v1`: 10 spec cards that exist only as pixels — signature,
rules, an examples table — with the produced code scored by **execution**
(the sandbox's own tests). Deterministic end to end.

The instrument convicted itself once before publishing: eight models scored
a uniform 0.967, the signature of an instrument bug, and it was — one test
sat on an IEEE rounding boundary (9.995 → 9.99), so every model "failed"
the trap. The spec moved off the boundary, the trap cells were staled, and
the re-published frontier reads true: **gpt-mini, gemini-flash and gpt-full
all at 1.000**, gpt-mini cheapest at $0.28/1k (code-gen vision v2).

Live probe: a never-seen spec image (`middleChar`) through the public API →
gpt-mini → working code, correct on a case the image never showed.

Vision now serves on FOUR clusters: extraction, rag-answer, classification,
code-gen. Uniform scores across all models are treated as an indictment of
the instrument first — that rule caught a real bug twice today.
