// @potion/lab-superpowers — the curated catalog (Step 11). The package
// format is the slottable unit: connector + authored usage + per-tool
// action classification + typed failures + a mini-eval, content-hashed and
// versioned, compiling DOWN to the Step 10 ConnectorDef.
export {
  CATALOG,
  LIVE_PROVEN_IDS,
  getPackage,
} from './catalog.js';
export {
  DEFAULT_TOKEN_BUDGET,
  MAX_TOKEN_BUDGET,
  contextContribution,
  contextTokens,
  estimateTokens,
  fixtureAgeDays,
  packageContentHash,
  toConnectorDef,
  toConnectorDefForFixture,
  validatePackage,
  type ConnectPosture,
  type FixtureStamp,
  type PackageIssue,
  type ProofTier,
  type SuperpowerPackage,
  type SuperpowerTool,
} from './format.js';
export {
  actTools,
  contextSurfaceOf,
  defaultGrantScopes,
  fixtureConnector,
  honestFixtureTools,
  hostileFixtureTools,
  readTools,
  toolsVisibleUnderDefaultGrant,
  type FixtureTool,
} from './mini-eval.js';
export { CLASSIFICATION_BASELINE, diffClassification, type ClassificationDiff } from './classification-gate.js';
export { recordFixture, type RecordedFixture } from './record.js';

import { CATALOG } from './catalog.js';
import { toConnectorDef } from './format.js';
import type { ConnectorDef } from '@potion/lab-mcp';

/**
 * The connectors the RUNTIME may use: every package that is `ready`
 * (endpoint + OAuth authored). Packages that are format-complete but
 * honestly unconnectable are absent — structurally, not by convention.
 */
export function connectableConnectors(): ConnectorDef[] {
  return CATALOG.map((p) => toConnectorDef(p)).filter((c): c is ConnectorDef => c !== null);
}
