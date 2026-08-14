// @potion/custody — the platform's reversible-secret custody, extracted
// VERBATIM from apps/server/src/custody (Step 10): the same envelope, the
// same providers, the same audited service — now importable by the WORKER,
// where the MCP client opens superpower grants, without a token-bearing
// API ever existing. The server re-exports this package from its old path;
// the BYOK suite moved here unchanged and passes unchanged (the relocation
// is additive by test, not by intent).
//   envelope.ts — AES-256-GCM envelope encryption (per-secret data key
//                 wrapped by the master key; tamper-evident via GCM tags).
//   master.ts   — MasterKeyProvider seam: env (POTION_MASTER_KEY) now,
//                 cloud KMS TODO; dev-file/ephemeral fallbacks with loud
//                 warnings.
//   service.ts  — the audited crypto boundary for BYOK provider keys:
//                 encrypt/decrypt/rotate with custody_audit writes.
export * from './envelope.js';
export * from './master.js';
export * from './service.js';
export * from './grants.js';
