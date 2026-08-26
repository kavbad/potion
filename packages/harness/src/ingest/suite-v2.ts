// v2 suite loader (ROADMAP M1a): loads suites/v2/<suiteId>/manifest.json +
// items (path or inline), validates the manifest and every item, and enforces
// the manifest cross-checks (clusterId match, scoring allowlist, reference
// when required). Old flat JSONL suites (suites.ts) keep working unchanged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EvalItemSchema, type EvalItem, flattenWireMessage } from '@potion/core';
import {
  SUITE_ID_RE,
  SuiteManifestSchema,
  crossCheckItem,
  type SuiteManifest,
} from './manifest.js';

/** packages/harness/suites/v2 (works from both src/ via tsx and dist/ after build). */
export const SUITES_V2_DIR = fileURLToPath(new URL('../../suites/v2', import.meta.url));

export interface LoadedSuiteV2 {
  manifest: SuiteManifest;
  items: EvalItem[];
}

function parseItemsJsonl(text: string, suiteId: string): EvalItem[] {
  const items: EvalItem[] = [];
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  lines.forEach((line, i) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new Error(`v2 suite '${suiteId}' items line ${i + 1}: invalid JSON — ${(e as Error).message}`);
    }
    const parsed = EvalItemSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`v2 suite '${suiteId}' items line ${i + 1}: invalid EvalItem — ${parsed.error.message}`);
    }
    // Wire → internal messages (G): image parts survive on `parts`; the
    // classifier/scorer text view stays on `content`.
    const flattened = { ...parsed.data, prompt: parsed.data.prompt.map((m) => flattenWireMessage(m as never).message) };
    items.push(flattened as EvalItem);
  });
  return items;
}

/** Why a suite is being loaded. 'search' (the default) covers everything that
 *  selects or tunes strategies — sweeps, legs, hardening, ad-hoc CLI runs.
 *  'confirmation' is ONLY the final promotion reading. Locked suites load
 *  exclusively under 'confirmation' — fail-closed at the loader so no search
 *  path can touch a confirmation instrument by accident. */
export type SuiteLoadPurpose = 'search' | 'confirmation';

export function loadSuiteV2(
  suiteId: string,
  dir: string = SUITES_V2_DIR,
  purpose: SuiteLoadPurpose = 'search',
): LoadedSuiteV2 {
  if (!SUITE_ID_RE.test(suiteId)) {
    throw new Error(`invalid suite id '${suiteId}' (expected [a-z0-9-]+)`);
  }
  const suiteDir = `${dir}/${suiteId}`;
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(`${suiteDir}/manifest.json`, 'utf8');
  } catch {
    throw new Error(`v2 suite '${suiteId}' not found at ${suiteDir}/manifest.json`);
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (e) {
    throw new Error(`v2 suite '${suiteId}': manifest.json invalid JSON — ${(e as Error).message}`);
  }
  const parsed = SuiteManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new Error(`v2 suite '${suiteId}': invalid manifest — ${parsed.error.message}`);
  }
  const manifest = parsed.data;
  if (manifest.suiteId !== suiteId) {
    throw new Error(
      `v2 suite '${suiteId}': manifest suiteId '${manifest.suiteId}' does not match directory name`,
    );
  }

  if (manifest.locked === true && purpose !== 'confirmation') {
    throw new Error(
      `v2 suite '${suiteId}' is LOCKED (confirmation-only): search tooling must not ` +
        `evaluate against it. Pass purpose 'confirmation' only from the final ` +
        `promotion reading.`,
    );
  }

  const items =
    typeof manifest.items === 'string'
      ? parseItemsJsonl(readFileSync(`${suiteDir}/${manifest.items}`, 'utf8'), suiteId)
      : (manifest.items as EvalItem[]);

  const problems = items.flatMap((item, i) => crossCheckItem(manifest, item, i));
  if (problems.length > 0) {
    throw new Error(
      `v2 suite '${suiteId}': manifest cross-check failed (${problems.length} problem(s)):\n  - ${problems.join('\n  - ')}`,
    );
  }
  return { manifest, items };
}

export function loadSuitesV2(
  suiteIds: string[],
  dir: string = SUITES_V2_DIR,
  purpose: SuiteLoadPurpose = 'search',
): LoadedSuiteV2[] {
  return suiteIds.map((id) => loadSuiteV2(id, dir, purpose));
}
