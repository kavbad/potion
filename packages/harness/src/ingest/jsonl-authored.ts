// jsonl-authored ingest adapter (ROADMAP M1a): validates an authored flat
// JSONL file of EvalItems (the v1 suite shape) and re-emits it for a v2 suite.
// Beyond EvalItemSchema validation it enforces manifest cross-checks:
//   - item.clusterId must match the target manifest's clusterId
//   - item.scoring.kind must be allowed for the cluster (CLUSTER_ALLOWED_SCORING)
//   - a reference must be present when the scoring kind requires one
// With `idPrefix`, old ids are kept stable-by-prefixing (new id = prefix + old
// id; the `EVAL: <id>` signature line in prompts is rewritten to match).
import { EvalItemSchema, type EvalItem } from '@potion/core';
import {
  clusterPolicyProblems,
  crossCheckItem,
  type SuiteManifest,
} from './manifest.js';

export interface AuthoredConvertOptions {
  /** Prepended to every old item id (keeps old ids stable by prefixing). */
  idPrefix?: string | undefined;
  /** Manifest cross-check context (clusterId + scoring allowlist). */
  manifest: Pick<SuiteManifest, 'suiteId' | 'clusterId' | 'scoring'>;
}

export interface AuthoredConvertResult {
  items: EvalItem[];
  warnings: string[];
}

/** Rewrite the leading `EVAL: <oldId>` signature line (if present) to the new id. */
function rewriteEvalSignature(content: string, oldId: string, newId: string): string {
  return content.replace(
    new RegExp(`^(EVAL:\\s*)${oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'm'),
    `$1${newId}`,
  );
}

/** Pure conversion: authored flat JSONL text → validated, id-prefixed EvalItems.
 * Throws with ALL problems listed when any item fails validation/cross-checks. */
export function convertAuthoredJsonl(
  text: string,
  opts: AuthoredConvertOptions,
): AuthoredConvertResult {
  const idPrefix = opts.idPrefix ?? '';
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const problems: string[] = [];
  const items: EvalItem[] = [];
  const seen = new Set<string>();

  lines.forEach((line, i) => {
    const where = `line ${i + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      problems.push(`${where}: invalid JSON — ${(e as Error).message}`);
      return;
    }
    const parsed = EvalItemSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`${where}: invalid EvalItem — ${parsed.error.message}`);
      return;
    }
    const old = parsed.data as EvalItem;
    const item: EvalItem = idPrefix
      ? {
          ...old,
          id: `${idPrefix}${old.id}`,
          prompt: old.prompt.map((m) => ({
            ...m,
            content: rewriteEvalSignature(m.content, old.id, `${idPrefix}${old.id}`),
          })),
        }
      : old;
    if (seen.has(item.id)) {
      problems.push(`${where}: duplicate item id '${item.id}'`);
      return;
    }
    seen.add(item.id);
    problems.push(...crossCheckItem(opts.manifest, item, i).map((p) => `${where}: ${p}`));
    problems.push(...clusterPolicyProblems(item, i).map((p) => `${where}: ${p}`));
    items.push(item);
  });

  if (problems.length > 0) {
    throw new Error(
      `authored JSONL failed validation (${problems.length} problem(s)):\n  - ${problems.join('\n  - ')}`,
    );
  }
  return { items, warnings: [] };
}
