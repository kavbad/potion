// mulberry32 — tiny seeded PRNG (SPEC §15.4 pins it for the promotion
// gate's paired bootstrap, and the candidate generator uses it for seeded
// tie-breaks). 32-bit state, fast, exactly reproducible across platforms
// (all arithmetic is uint32 / Math.imul — no float drift).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
