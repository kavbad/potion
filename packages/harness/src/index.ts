// @potion/harness public surface (SPEC §5).
export * from './scorers.js';
// Additive (M1b sweep script): reuse the CLI's results-table formatter and
// strategy labeler so scripts/m1b-sweep.ts renders the Gate-3 table verbatim
// instead of replicating it. Importing cli.ts here is side-effect-free (its
// main() only runs when cli.ts is the direct entrypoint).
export { formatResultsTable, strategyLabel } from './cli.js';
export * from './aggregate.js';
export * from './estimate.js';
export * from './suites.js';
export * from './runner.js';
export * from './calibrate.js';
export * from './ingest/index.js';
export * from './staleness.js';
