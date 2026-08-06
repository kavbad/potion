export * from './types.js';
export * from './prices.js';
export * from './errors.js';
export * from './http.js';
export * from './resilience.js';
export * from './factory.js';
export { createMockProvider, latencyProfileMs, MOCK_PROVIDER_DISCLAIMER } from './mock/mock.js';
export { mockEmbedText, baseCentroid, EMBEDDING_DIM, NOISE_MAX_NORM } from './mock/embedding.js';
export { seedClusterOf, CLUSTER_KEYWORDS } from './mock/fixtures.js';
// Phase 3 (additive): eval corpus + mock-world quality model for @potion/harness.
// M1a quarantine: these live in mock/eval-corpus.ts — TEST/CI SIMULATION ONLY.
export {
  EVAL_CORPUS,
  evalTaskById,
  extractEvalTaskId,
  corruptionRateForModel,
  corpusCorrectness,
  corruptAnswer,
  evalAnswerText,
  OFF_TOPIC_SENTENCES,
  // M3 #23 (TEST/CI SIMULATION ONLY): composite confidence fixture knob.
  MOCK_CONFIDENCE_OVERRIDE_RE,
  mockConfidenceOverride,
} from './mock/eval-corpus.js';
export type { EvalCorpusTask, EvalTaskKind, EvalFieldType } from './mock/eval-corpus.js';
export { hashString, mulberry32 } from './mock/rng.js';
export * from './scan.js';
