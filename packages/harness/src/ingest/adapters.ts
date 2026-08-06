// Ingest adapter registry (ROADMAP M1a): source kind → adapter. Adapters are
// pure functions (text + options → {manifest, items, warnings}); file IO lives
// in ingest/cli.ts. Each adapter produces a COMPLETE v2 manifest so the CLI
// only serializes the result.
import type { ClusterId, EvalItem } from '@potion/core';
import { convertHumanEval, type JsTranspilation } from './humaneval.js';
import { convertAuthoredJsonl } from './jsonl-authored.js';
import {
  SuiteManifestSchema,
  type ScoringKind,
  type SuiteManifest,
  type SuiteSource,
} from './manifest.js';

export interface IngestRequest {
  suiteId: string;
  clusterId: ClusterId;
  /** Defaults to '1.0.0'. */
  version?: string | undefined;
  /** Prepended to item ids (keeps old ids stable by prefixing). */
  idPrefix?: string | undefined;
  /** Overrides the adapter's default source provenance. */
  source?: Partial<SuiteSource> | undefined;
  /** Manifest scoring allowlist; defaults to the kinds present in the items. */
  scoringAllowed?: [ScoringKind, ...ScoringKind[]] | undefined;
  /** humaneval only: task_id → faithful JS transpilation. */
  transpilations?: Record<string, JsTranspilation> | undefined;
  /** Defaults to now (ISO). Injectable for deterministic tests. */
  createdAt?: string | undefined;
}

export interface IngestResult {
  manifest: SuiteManifest;
  items: EvalItem[];
  warnings: string[];
}

export interface IngestAdapter {
  /** Registry key / CLI `--source` value. */
  source: string;
  description: string;
  /** Default provenance when the request doesn't override it. */
  defaultSource: Omit<SuiteSource, 'kind'> & { kind: SuiteSource['kind'] };
  convert(raw: string, req: IngestRequest): { items: EvalItem[]; warnings: string[] };
}

export const HUMANEVAL_DEFAULT_SOURCE: SuiteSource = {
  kind: 'public-benchmark',
  name: 'HumanEval (OpenAI)',
  license: 'MIT',
  uri: 'https://github.com/openai/human-eval',
};

export const AUTHORED_DEFAULT_SOURCE: SuiteSource = {
  kind: 'authored',
  name: 'Potion-authored eval items',
  license: 'Proprietary (Potion-authored)',
};

export const ADAPTERS: Readonly<Record<string, IngestAdapter>> = {
  humaneval: {
    source: 'humaneval',
    description:
      'HumanEval-format JSONL ({task_id, prompt, canonical_solution, test, entry_point}) → code-gen code-exec items. JS only for hand-transpiled tasks; others emitted as python and skipped by the runner.',
    defaultSource: HUMANEVAL_DEFAULT_SOURCE,
    convert: (raw, req) =>
      convertHumanEval(raw, {
        clusterId: req.clusterId,
        idPrefix: req.idPrefix,
        transpilations: req.transpilations,
      }),
  },
  'jsonl-authored': {
    source: 'jsonl-authored',
    description:
      'Authored flat JSONL of EvalItems (v1 suite shape) → validated v2 items with manifest cross-checks (clusterId match, scoring allowed for cluster, reference present when required).',
    defaultSource: AUTHORED_DEFAULT_SOURCE,
    convert: (raw, req) =>
      convertAuthoredJsonl(raw, {
        idPrefix: req.idPrefix,
        manifest: {
          suiteId: req.suiteId,
          clusterId: req.clusterId,
          scoring: { allowed: req.scoringAllowed },
        },
      }),
  },
};

export function getAdapter(source: string): IngestAdapter {
  const adapter = ADAPTERS[source];
  if (!adapter) {
    throw new Error(
      `unknown ingest source '${source}' (known: ${Object.keys(ADAPTERS).join(', ')})`,
    );
  }
  return adapter;
}

function uniqKinds(items: EvalItem[]): [ScoringKind, ...ScoringKind[]] | undefined {
  const kinds = [...new Set(items.map((i) => i.scoring.kind))];
  return kinds.length > 0 ? (kinds as [ScoringKind, ...ScoringKind[]]) : undefined;
}

/** Run an adapter end-to-end: convert + assemble + validate the v2 manifest. */
export function ingest(source: string, raw: string, req: IngestRequest): IngestResult {
  const adapter = getAdapter(source);
  const { items, warnings } = adapter.convert(raw, req);
  const manifest: SuiteManifest = SuiteManifestSchema.parse({
    suiteId: req.suiteId,
    clusterId: req.clusterId,
    version: req.version ?? '1.0.0',
    source: { ...adapter.defaultSource, ...req.source },
    items: 'items.jsonl',
    scoring: { allowed: req.scoringAllowed ?? uniqKinds(items) },
    createdAt: req.createdAt ?? new Date().toISOString(),
  });
  return { manifest, items, warnings };
}
