# Simulated suites — TEST/CI SIMULATION ONLY

The suites in this directory (`code-gen.jsonl`, `extraction.jsonl`) were
**generated from the mock provider's eval corpus**
(`packages/providers/src/mock/eval-corpus.ts` — tasks + uncorrupted reference
answers + deterministic corruption engine). Their prompts carry `EVAL: <id>`
signatures and their references are the corpus's uncorrupted answers *by
construction*: the same module that generates these suites is the module that
answers them.

They are retained **only for CI pipeline tests** — they let the full harness
(runner → scorers → aggregation → persistence) run deterministically with
gradable answers and zero network.

**These suites must never be presented as evidence of real-world quality.**
A result on a simulated suite measures the mock's corruption model, not any
real model. The runner enforces this: `runEval` refuses to load suites from
this directory unless the caller passes `simulatedOk` / `--simulated-ok`, and
marks the resulting `RunSummary` with `simulated: true`.

Regeneration (deprecated, test-only): `pnpm --filter @potion/harness gen:simulated-suites`.

For real-world quality evidence use independently authored, license-clean
benchmarks ingested via the harness ingest path (`packages/harness/ingest`,
`packages/harness/suites/v2`) with a live provider.
