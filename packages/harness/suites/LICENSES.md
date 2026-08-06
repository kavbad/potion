# Suite license audit (ROADMAP M1a)

Provenance for every benchmark/source ingested into `suites/v2/`. Conservative
rule: **anything not verified below must be treated as "verify before shipping
to customers"** (redistribution terms, attribution strings, and contamination
policy all need legal sign-off before customer-facing redistribution).

## Audited sources

### HumanEval (OpenAI) — MIT

- Upstream: https://github.com/openai/human-eval — license file: MIT
  (Copyright (c) OpenAI).
- **License:** MIT — permissive; redistribution (including modified subsets)
  is allowed.
- **Redistribution-ok:** yes, provided the MIT copyright notice and license
  text are preserved with any redistributed portion.
- **Attribution-required:** yes (MIT notice retention). Suggested attribution
  line: "Contains data derived from HumanEval (https://github.com/openai/human-eval),
  Copyright (c) OpenAI, licensed under MIT."
- **Notes:** the MIT grant covers the benchmark data/code, not model outputs
  produced against it. HumanEval is a well-known pretraining-contamination
  risk — treat inflated scores on public models as a measurement hazard, not
  a license issue.
- **Current usage:** `suites/v2/code-gen-humaneval-js-v1` contains only
  Potion-authored, HumanEval-*format-compatible* originals (no actual
  HumanEval content was copied), so the suite itself is Proprietary
  (Potion-authored). The MIT row applies the moment real HumanEval tasks are
  ingested via `--source humaneval`.

## Audit table template (append one row per new source)

| benchmark | license | redistribution-ok | attribution-required | notes |
|---|---|---|---|---|
| HumanEval (OpenAI) | MIT | yes (keep MIT notice) | yes (MIT notice) | contamination risk on public models; verified from upstream LICENSE |
| GSM8K (OpenAI) | MIT (verify before shipping to customers) | likely yes | likely yes | verify upstream LICENSE before ingesting |
| MMLU (Hendrycks et al.) | MIT (verify before shipping to customers) | likely yes | likely yes | some forks carry different terms; verify exact upstream |
| BIG-bench (Google) | Apache-2.0 (verify before shipping to customers) | likely yes | yes (NOTICE if present) | per-task metadata may carry third-party terms; verify per task |
| MBPP (Google) | CC-BY-4.0 (verify before shipping to customers) | likely yes | yes | verify upstream before ingesting |
| SWE-bench (Princeton) | MIT for code; task data scraped from GitHub (verify before shipping to customers) | unclear | unclear | repo content carries upstream project licenses; do NOT redistribute without review |
| AlpacaEval / instruction sets | mixed (verify before shipping to customers) | unclear | unclear | may contain model-generated text with ToS restrictions; verify provenance |
| Potion-authored suites (suites/v2/*-authored-*) | Proprietary (Potion-authored) | n/a (ours) | no | no third-party content; safe to ship |

Column meanings:

- **license** — SPDX id when verified from the upstream LICENSE file;
  otherwise a best-effort guess explicitly marked "verify before shipping to
  customers".
- **redistribution-ok** — whether we may redistribute the items (or a
  modified subset) inside our product/fixtures.
- **attribution-required** — whether redistribution requires retaining a
  copyright notice / credit line.
- **notes** — contamination risk, per-item third-party terms, ToS concerns.
