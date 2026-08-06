// Taxonomy + held-out set loading (SPEC §4). The real data files live in
// packages/cluster/data/ (authored on the phase2-data branch):
//   taxonomy.json  : {"version": string, "clusters": [{id, name, description, exemplars: string[>=25]}]}
//   heldout.jsonl  : one {"id", "clusterId", "text"} object per line (20 per cluster)
// Both are parsed strictly with zod so a malformed file fails with a clear,
// located error instead of a silent bad centroid downstream.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ClusterId } from '@potion/core';

/** Default path of the shipped 10-cluster taxonomy (packages/cluster/data/taxonomy.json). */
export const TAXONOMY_PATH = fileURLToPath(new URL('../data/taxonomy.json', import.meta.url));

/** Default path of the shipped held-out evaluation set (packages/cluster/data/heldout.jsonl). */
export const HELDOUT_PATH = fileURLToPath(new URL('../data/heldout.jsonl', import.meta.url));

export const TaxonomyClusterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  exemplars: z.array(z.string().min(1)).min(1),
});

export const TaxonomySchema = z.object({
  version: z.string().min(1),
  clusters: z.array(TaxonomyClusterSchema).min(1),
});

export type TaxonomyCluster = z.infer<typeof TaxonomyClusterSchema> & { id: ClusterId };
export type Taxonomy = Omit<z.infer<typeof TaxonomySchema>, 'clusters'> & {
  clusters: TaxonomyCluster[];
};

export const HeldoutExampleSchema = z.object({
  id: z.string().min(1),
  clusterId: z.string().min(1),
  text: z.string().min(1),
});

export type HeldoutExample = z.infer<typeof HeldoutExampleSchema> & { clusterId: ClusterId };

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Load + validate a taxonomy JSON file. Throws an Error whose message names
 * the file and every schema violation when the file is missing, unparseable,
 * or fails validation. Also rejects duplicate cluster ids.
 */
export function loadTaxonomy(path: string = TAXONOMY_PATH): Taxonomy {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`loadTaxonomy: cannot read taxonomy file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadTaxonomy: ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = TaxonomySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`loadTaxonomy: ${path} failed schema validation:\n${formatZodError(result.error)}`);
  }
  const seen = new Set<string>();
  for (const cluster of result.data.clusters) {
    if (seen.has(cluster.id)) {
      throw new Error(`loadTaxonomy: ${path} contains duplicate cluster id "${cluster.id}"`);
    }
    seen.add(cluster.id);
  }
  return result.data as Taxonomy;
}

/**
 * Load + validate a held-out JSONL file (one {id, clusterId, text} per line).
 * Blank lines are ignored; every other line must be valid JSON matching the
 * schema, or the error names the file and 1-based line number.
 */
export function loadHeldout(path: string = HELDOUT_PATH): HeldoutExample[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`loadHeldout: cannot read heldout file at ${path}: ${(err as Error).message}`);
  }
  const examples: HeldoutExample[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`loadHeldout: ${path}:${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    const result = HeldoutExampleSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `loadHeldout: ${path}:${i + 1} failed schema validation:\n${formatZodError(result.error)}`,
      );
    }
    examples.push(result.data as HeldoutExample);
  }
  if (examples.length === 0) {
    throw new Error(`loadHeldout: ${path} contains no examples`);
  }
  return examples;
}
