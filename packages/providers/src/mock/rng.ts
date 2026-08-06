// Deterministic seeded RNG helpers for the mock provider (SPEC §2).
// No external deps; FNV-1a string hash + mulberry32 PRNG.

/** FNV-1a 32-bit hash of a string → unsigned int. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny deterministic PRNG, returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive the mock seed: explicit params.seed wins, else hash of the prompt. */
export function seedOf(seedParam: number | undefined, promptText: string): number {
  return seedParam ?? hashString(promptText);
}
