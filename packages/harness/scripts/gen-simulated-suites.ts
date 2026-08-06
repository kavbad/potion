// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED — TEST/CI SIMULATION ONLY.
//
// Simulated-suite generator (formerly `gen:suites`, SPEC §5): projects the
// mock eval corpus (packages/providers/src/mock/eval-corpus.ts — TEST/CI
// SIMULATION ONLY, never authoritative for customer-facing evals) into
// suites/simulated/code-gen.jsonl + suites/simulated/extraction.jsonl.
//
// PROVENANCE WARNING: the emitted references are the corpus's UNCORRUPTED
// answers by construction, so these suites are coupled to the mock and can
// NEVER be presented as evidence of real-world quality. They exist only so CI
// can exercise the harness pipeline deterministically. See
// packages/harness/suites/simulated/README.md. Real benchmark suites come
// from the ingest path (packages/harness/ingest → suites/v2), not this script.
//
// Regenerate: pnpm --filter @potion/harness gen:simulated-suites
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EVAL_CORPUS, type EvalCorpusTask } from '@potion/providers';
import type { EvalItem } from '@potion/core';

const SIMULATED_SUITES_DIR = fileURLToPath(new URL('../suites/simulated', import.meta.url));

/** Provenance header (JSONL comment; the loader skips `//` lines). */
const PROVENANCE_HEADER =
  '// provenance: SIMULATED — generated from the mock eval corpus ' +
  '(packages/providers/src/mock/eval-corpus.ts); TEST/CI SIMULATION ONLY, ' +
  'never evidence of real-world quality (see suites/simulated/README.md)';

function codeItem(task: EvalCorpusTask): EvalItem {
  return {
    id: task.id,
    clusterId: 'code-gen',
    prompt: [
      {
        role: 'user',
        content:
          `EVAL: ${task.id}\n${task.task}\n\n` +
          'Respond with ONLY the JavaScript function source, no markdown fences, no explanation.',
      },
    ],
    reference: task.reference,
    scoring: { kind: 'code-exec', language: 'javascript', tests: task.tests ?? '' },
  };
}

function extractItem(task: EvalCorpusTask): EvalItem {
  return {
    id: task.id,
    clusterId: 'extraction',
    prompt: [
      {
        role: 'user',
        content: `EVAL: ${task.id}\n${task.task}\n\nRespond with ONLY the JSON object, no markdown fences.`,
      },
    ],
    reference: JSON.parse(task.reference) as unknown,
    scoring: { kind: 'field-match', schema: task.schema ?? {} },
  };
}

console.warn(
  'DEPRECATED (test-only): gen:simulated-suites regenerates mock-corpus-derived ' +
    'suites under suites/simulated/ — CI simulation fixtures, NOT real-world benchmarks.',
);

const code = EVAL_CORPUS.filter((t) => t.kind === 'code').map(codeItem);
const extract = EVAL_CORPUS.filter((t) => t.kind === 'extract').map(extractItem);

for (const [name, items] of [
  ['code-gen', code],
  ['extraction', extract],
] as const) {
  const path = `${SIMULATED_SUITES_DIR}/${name}.jsonl`;
  writeFileSync(
    path,
    [PROVENANCE_HEADER, ...items.map((i) => JSON.stringify(i))].join('\n') + '\n',
  );
  console.log(`wrote ${path} (${items.length} items)`);
}
