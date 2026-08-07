// mulberry32 — SPEC §15.4 pins this PRNG for the promotion gate's paired
// bootstrap and the candidate generator's seeded tie-breaks. The
// implementation moved VERBATIM to @potion/core stats.ts (G0.3: the
// guarantee's breach CI uses the same pinned primitive); this re-export
// keeps researcher imports and sequences bit-identical.
export { mulberry32 } from '@potion/core';
