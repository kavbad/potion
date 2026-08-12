// Content hash for harness specs (Lab) — the F7 discipline applied to specs.
//
// Identity is sha256 over canonicalJson (stable key order, no whitespace)
// with the embedded `hash` field EXCLUDED from the hashed content — a hash
// that covered itself could never verify. Same machinery and same reasoning
// as core's suiteContentHash: an identity that flips on key order would be
// a random refusal generator.
//
// Deliberately NO unicode normalization: the hash covers exact strings.
// NFC-folding would make two visually identical specs hash equal while the
// model sees different bytes — identity must track what the model sees.
import { canonicalJson, sha256 } from '@potion/core';
import type { HarnessSpec } from './types.js';

export function harnessSpecHash(spec: HarnessSpec): string {
  const { hash: _embedded, ...content } = spec;
  return sha256(canonicalJson(content));
}
