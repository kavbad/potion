// @potion/lab-runtime — Lab Step 3: the loop executor.
//
// Serving is consumed STRICTLY as a client (ServingClient over HTTP —
// touchpoint 1); run state, checkpoints, and harness memory live in
// @potion/db under the tenancy machinery (operator ruling 2026-08-11).
// deps.test.ts makes "no provider-call paths" structural: @potion/providers
// must not appear anywhere in this package's dependency tree.
export { ServingClient, type ServingResult, type ServingRequest } from './serving-client.js';
export { contractRepairMessage, contractRepairsIn, CONTRACT_REPAIR_PREFIX, runLeg, systemClock, WRAP_UP_PROMPT, wrapUpMessage, type Clock, type LabTool, type LegOutcome, type RunLegOptions } from './loop.js';
export { extractDeliverable, type DeliverableResult } from './deliverable.js';
export { buildWebLabTools, checkUrl, htmlToText, isPrivateAddress, parseFeed, WEB_LIMITS, type WebToolDeps } from './web-tools.js';
export { buildStepPayload, SecretInCheckpointError, type StepPayload } from './checkpoint.js';
export { spansForSteps, capContent, SPAN_CONTENT_MAX_CHARS, SPAN_TRUNCATION_MARKER } from './spans.js';
export {
  replayRun,
  type RecordedStep,
  type RecordedTerminal,
  type ReplayDivergence,
  type ReplayDivergenceCode,
  type ReplayResult,
} from './replay.js';
export { startRun, resumeRun } from './cli.js';
export { buildRunReport, type RunReportV1, type StepCostRow, type StruggleEvidence } from './report.js';
export {
  buildMcpLabTools,
  TOKEN_REFRESH_WINDOW_MS,
  type McpLegNote,
  type McpLegSetup,
  type McpLegSetupOptions,
  type SuperpowerUnavailable,
  type ToolCallError,
} from './mcp-tools.js';
export * from './graduation.js';
export * from './evidence.js';
export * from './apply-graduation.js';
