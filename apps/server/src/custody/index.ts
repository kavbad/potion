// Custody module (M2 Wave 2, ROADMAP #15/#16): real BYOK key custody.
//   envelope.ts — AES-256-GCM envelope encryption (per-key data key wrapped
//                 by the master key; tamper-evident via GCM auth tags).
//   master.ts   — MasterKeyProvider seam: env (POTION_MASTER_KEY) now,
//                 cloud KMS TODO; dev-file/ephemeral fallbacks with loud
//                 warnings.
//   service.ts  — the audited crypto boundary: encrypt/decrypt/rotate with
//                 custody_audit writes on every sensitive operation.
export * from './envelope.js';
export * from './master.js';
export * from './service.js';
