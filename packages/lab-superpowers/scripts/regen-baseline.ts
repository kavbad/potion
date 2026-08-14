// Regenerate the classification baseline (review addition 2). Running this
// is the DELIBERATE act that accepts a pore change; the diff in the
// committed JSON is the visible record.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../src/catalog.js';
import { buildBaseline, type BaselineEntry } from '../src/classification-gate.js';

const out = fileURLToPath(new URL('../baseline/classification.json', import.meta.url));
// The PRIOR baseline is an input: buildBaseline refuses to write a pore
// removal whose version did not move, so this command cannot launder one
// (Step 11 review finding — regeneration used to be the laundering path).
const prior = JSON.parse(readFileSync(out, 'utf8')) as Record<string, BaselineEntry>;
writeFileSync(out, JSON.stringify(buildBaseline(CATALOG, prior), null, 2) + '\n');
console.log(`classification baseline written: ${out} (${CATALOG.length} packages)`);
