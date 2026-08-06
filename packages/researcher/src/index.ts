// @potion/researcher — the autoresearcher's pure core (M4b, ROADMAP #37,
// SPEC §15): candidate generation (template grammar × class-pruned registry)
// and the live-evidence promotion gate (paired bootstrap, mulberry32-seeded).
// Deliberately db-free: workers/server do the I/O, this package decides.
export * from './rng.js';
export * from './registry.js';
export * from './generate.js';
export * from './gate.js';
