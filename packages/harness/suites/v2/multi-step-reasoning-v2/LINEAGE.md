# multi-step-reasoning-v2 — lineage

Supersedes the flat suite `packages/harness/suites/multi-step-reasoning.jsonl`.
That file is LEFT IN PLACE: platform-frontiers.json cluster `multi-step-reasoning` v3
cites it as the evidence for nine live points, and deleting it would orphan them.

## What changed

1. The answer-format demand moved out of the free text and onto one labelled last
   line (`Final answer: <form>`), carried in a system message.
2. Scoring reads that line instead of the whole answer.
3. Item ids are new, so no v1 cache cell can resume into a v2 run.
4. `multi-step-reasoning-008` was internally contradictory — it opened with
   "answer with just the final number" and closed with "Answer with just the day
   name", against gold `Sunday`. msr2-008 asks only for the day.

## Item map

| v2 id | v1 id | extract | gold |
|---|---|---|---|
| msr2-001 | multi-step-reasoning-001 | final-number | `24` |
| msr2-002 | multi-step-reasoning-002 | final-number | `210` |
| msr2-003 | multi-step-reasoning-003 | final-answer | `Sam` |
| msr2-004 | multi-step-reasoning-004 | final-number | `10` |
| msr2-005 | multi-step-reasoning-005 | final-number | `18` |
| msr2-006 | multi-step-reasoning-006 | final-number | `12` |
| msr2-007 | multi-step-reasoning-007 | final-number | `54` |
| msr2-008 | multi-step-reasoning-008 | final-answer | `Sunday` |
| msr2-009 | multi-step-reasoning-009 | final-answer | `3/7` |
| msr2-010 | multi-step-reasoning-010 | final-answer | `12:40` |
| msr2-011 | multi-step-reasoning-011 | final-number | `74` |
| msr2-012 | multi-step-reasoning-012 | final-number | `42` |
| msr2-013 | multi-step-reasoning-013 | final-answer | `yes` |
| msr2-014 | multi-step-reasoning-014 | final-number | `17` |
| msr2-015 | multi-step-reasoning-015 | final-number | `150` |
| msr2-016 | multi-step-reasoning-016 | final-number | `60` |
| msr2-017 | multi-step-reasoning-017 | final-number | `2` |
| msr2-018 | multi-step-reasoning-018 | final-number | `82` |
| msr2-019 | multi-step-reasoning-019 | final-answer | `saturday` |
| msr2-020 | multi-step-reasoning-020 | final-number | `105` |
| msr2-021 | multi-step-reasoning-021 | final-number | `90` |
| msr2-022 | multi-step-reasoning-022 | final-number | `7` |
| msr2-023 | multi-step-reasoning-023 | final-answer | `b` |
| msr2-024 | multi-step-reasoning-024 | final-answer | `10:15 pm` |
| msr2-025 | multi-step-reasoning-025 | final-number | `90.72` |
| msr2-026 | multi-step-reasoning-026 | final-number | `2` |
| msr2-027 | multi-step-reasoning-027 | final-number | `5` |
| msr2-028 | multi-step-reasoning-028 | final-number | `12` |
| msr2-029 | multi-step-reasoning-029 | final-answer | `wednesday` |
| msr2-030 | multi-step-reasoning-030 | final-number | `190` |
| msr2-031 | multi-step-reasoning-031 | final-number | `5` |
| msr2-032 | multi-step-reasoning-032 | final-number | `18` |
| msr2-033 | multi-step-reasoning-033 | final-number | `85` |
| msr2-034 | multi-step-reasoning-034 | final-number | `3` |
| msr2-035 | multi-step-reasoning-035 | final-number | `3` |
| msr2-036 | multi-step-reasoning-036 | final-number | `54` |
| msr2-037 | multi-step-reasoning-037 | final-number | `10` |
| msr2-038 | multi-step-reasoning-038 | final-number | `6` |
| msr2-039 | multi-step-reasoning-039 | final-answer | `sunday` |
| msr2-040 | multi-step-reasoning-040 | final-number | `23` |
| msr2-041 | multi-step-reasoning-041 | final-number | `24` |
| msr2-042 | multi-step-reasoning-042 | final-answer | `yes` |
| msr2-043 | multi-step-reasoning-043 | final-number | `69.30` |
| msr2-044 | multi-step-reasoning-044 | final-number | `48` |
| msr2-045 | multi-step-reasoning-045 | final-number | `3.5` |
| msr2-046 | multi-step-reasoning-046 | final-answer | `sunday` |
| msr2-047 | multi-step-reasoning-047 | final-number | `16` |
| msr2-048 | multi-step-reasoning-048 | final-answer | `7:00 am` |
| msr2-049 | multi-step-reasoning-049 | final-number | `66` |
| msr2-050 | multi-step-reasoning-050 | final-number | `4` |
