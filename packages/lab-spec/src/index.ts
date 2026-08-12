// @potion/lab-spec — the harness spec (Lab): types, validators, content hash.
//
// This package is Lab Step 2 of docs/LAB-BUILD-PLAN.md. It has NO runtime,
// NO routes, NO db, NO spend — it can parse, validate, and hash a harness
// file, nothing else. Dependency surface is @potion/core + zod by design;
// importing workers/server/db from here is a contract violation.
export * from './types.js';
export { HarnessSpecSchema, LabPolicySchema } from './schema.js';
export { parseHarnessSpec, parseHarnessSpecText } from './parse.js';
export { harnessSpecHash } from './hash.js';
export * as SPEC_LIMITS from './limits.js';
