// The superpower PACKAGE format (Step 11 §1) — the curated superset of a
// Step 10 ConnectorDef: the connector plus authored usage, per-tool action
// classification, least-privilege defaults, and a mini-eval. One
// content-addressed, versioned unit that compiles DOWN to the ConnectorDef
// the Step 10 runtime already consumes: the machinery is unchanged, the
// catalog is new.
//
// Honesty rules baked into the TYPES, not the prose:
//   · `proof` never claims live-proven without a ledgered live run
//     (meta-tested), and a RECORDED fixture must carry its capture stamp
//     (review addition 3) so staleness is visible as real APIs drift.
//   · `connect` is a discriminated union: a package whose endpoint we have
//     not verified, or whose OAuth endpoints we have not authored, is
//     STRUCTURALLY unconnectable — toConnectorDef returns null. A catalog
//     entry can be format-complete and mini-eval-proven while being
//     honestly unusable against a live wire; those are different claims
//     and the type keeps them different.
import { canonicalJson, sha256 } from '@potion/core';
import type { ConnectorDef, ConnectorOauth, ConnectorToolDef } from '@potion/lab-mcp';

/** Proof provenance (§5) — three tiers, never conflated. */
export type ProofTier = 'fixture-authored' | 'fixture-recorded' | 'live-proven';

/** Capture stamp for a RECORDED fixture (review addition 3). */
export interface FixtureStamp {
  /** ISO date the server's tools/list was captured. */
  capturedAt: string;
  /** serverInfo.name/version as the server reported it at capture. */
  serverVersion: string;
  /** The exact endpoint the capture came from. */
  capturedFrom: string;
}

export interface SuperpowerTool {
  /** The MCP tool name (also the allowlist key). */
  name: string;
  /** §2. NOT optional: an unclassified tool is unrepresentable here, and
   * the RUNTIME defaults anything undeclared to 'act', fail-closed. */
  action: 'read' | 'act';
  /** Required OAuth scopes for this tool. */
  requiredScopes: string[];
  /** AUTHORED description — the trusted text that reaches model context,
   * replacing the server's tools/list prose. */
  description: string;
  /** AUTHORED JSON Schema — replaces the server's inputSchema, because
   * parameter descriptions reach model context by the same path. */
  parameters: Record<string, unknown>;
  /** Authored sample result the mini-eval's fixture server returns. */
  sampleResult: unknown;
}

/** How (and whether) this package can reach a live wire. */
export type ConnectPosture =
  | { status: 'ready'; baseUrl: string; oauth: ConnectorOauth; revocationUrl?: string }
  | { status: 'endpoint-unverified'; note: string }
  | { status: 'oauth-unauthored'; baseUrl: string; note: string };

export interface SuperpowerPackage {
  id: string;
  version: string;
  displayName: string;
  category: string;
  transport: 'streamable-http';
  connect: ConnectPosture;
  tools: SuperpowerTool[];
  usage: {
    /** The capability preamble — where the package's guidance enters
     * context. Counted against the budget with every tool description. */
    preamble: string;
    /** MAX estimated tokens the package's total context contribution may
     * spend (preamble + every authored tool description). Test-enforced. */
    tokenBudget: number;
  };
  /** Least-privilege: the MINIMUM scope set the mini-eval needs (§6). */
  defaultScopes: string[];
  /**
   * Step 12 (T8): tools whose ACT is funded by the DEFAULT grant because
   * the vendor publishes no narrower scope — keyed by tool name, valued by
   * the reason. Declaring one is not a waiver: it is the honest record of a
   * least-privilege LIMIT the vendor imposes, and the least-privilege test
   * demands the reason rather than accepting silence.
   *
   * The invariant used to pass for Salesforce only because `update_record`
   * asked for `api_write`, a scope Salesforce does not have — a test
   * satisfied by a fiction. That is why the escape hatch is typed, per
   * tool, and surfaced rather than commented.
   */
  scopeLimits?: Record<string, string>;
  proof: ProofTier;
  /** REQUIRED when proof === 'fixture-recorded' (meta-tested). */
  fixtureStamp?: FixtureStamp;
  /** Hostile results shaped for THIS connector (§4). */
  injectionPayloads: string[];
}

/** Catalog-wide default context budget per package (§7). */
export const DEFAULT_TOKEN_BUDGET = 400;
/** Nothing in the catalog may exceed this, whatever it declares. */
export const MAX_TOKEN_BUDGET = 700;

/**
 * Token ESTIMATE (chars/4) — deliberately approximate and named as such
 * (spec §11): this is not the serving tokenizer, it is a budget guard with
 * margin. A package near its ceiling should shorten prose, not tune the
 * estimator.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Everything a package contributes to model context, concatenated. */
export function contextContribution(pkg: SuperpowerPackage): string {
  return [pkg.usage.preamble, ...pkg.tools.map((t) => t.description)].join('\n');
}

export function contextTokens(pkg: SuperpowerPackage): number {
  return estimateTokens(contextContribution(pkg));
}

/**
 * The HASHED SUBSET — what the content hash pins: everything that changes
 * BEHAVIOR (id, transport, connect posture, default scopes, proof tier,
 * usage text, and every tool's name/action/scopes/description/parameters).
 *
 * `version` is DELIBERATELY EXCLUDED. The F7 lesson is that identity must
 * be the CONTENT, never a label — and it is also what makes the
 * classification gate (review addition 2) a real two-factor check: the
 * hash moves when the content moves (it cannot be forgotten), and the
 * version moves only when a human declares the change. If the version were
 * hashed, a bump alone would move the hash and the second factor would be
 * decorative.
 */
export function packageContentHash(pkg: SuperpowerPackage): string {
  return sha256(
    canonicalJson({
      id: pkg.id,
      transport: pkg.transport,
      connect: pkg.connect,
      defaultScopes: [...pkg.defaultScopes].sort(),
      proof: pkg.proof,
      usage: pkg.usage,
      tools: [...pkg.tools]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((t) => ({
          name: t.name,
          action: t.action,
          requiredScopes: [...t.requiredScopes].sort(),
          description: t.description,
          parameters: t.parameters,
        })),
    }),
  );
}

export interface PackageIssue {
  code:
    | 'empty-id'
    | 'bad-version'
    | 'no-tools'
    | 'duplicate-tool'
    | 'budget-exceeded'
    | 'budget-too-high'
    | 'default-scope-not-least-privilege'
    | 'act-tool-scope-in-default'
    | 'funded-act-without-limit'
    | 'missing-fixture-stamp'
    | 'unearned-live-proven'
    | 'no-injection-payloads'
    | 'empty-description';
  detail: string;
}

/**
 * Structural validation — the rules that keep the catalog honest. Returns
 * every issue (not just the first) so a catalog report can show them all.
 *
 * `liveProvenIds` is the set of packages with a LEDGERED live run; a
 * package claiming 'live-proven' outside that set is a typed issue, so the
 * tier cannot be granted by editing a string.
 */
export function validatePackage(
  pkg: SuperpowerPackage,
  liveProvenIds: ReadonlySet<string> = new Set(),
): PackageIssue[] {
  const issues: PackageIssue[] = [];
  if (pkg.id.trim() === '') issues.push({ code: 'empty-id', detail: 'id is empty' });
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    issues.push({ code: 'bad-version', detail: `version '${pkg.version}' is not semver` });
  }
  if (pkg.tools.length === 0) issues.push({ code: 'no-tools', detail: 'package declares no tools' });
  const seen = new Set<string>();
  for (const t of pkg.tools) {
    if (seen.has(t.name)) issues.push({ code: 'duplicate-tool', detail: t.name });
    seen.add(t.name);
    if (t.description.trim() === '') {
      issues.push({ code: 'empty-description', detail: `${t.name} has no authored description` });
    }
  }
  const tokens = contextTokens(pkg);
  if (tokens > pkg.usage.tokenBudget) {
    issues.push({
      code: 'budget-exceeded',
      detail: `${tokens} est tokens > declared budget ${pkg.usage.tokenBudget}`,
    });
  }
  if (pkg.usage.tokenBudget > MAX_TOKEN_BUDGET) {
    issues.push({
      code: 'budget-too-high',
      detail: `declared budget ${pkg.usage.tokenBudget} > catalog ceiling ${MAX_TOKEN_BUDGET}`,
    });
  }
  // Least privilege (§6): the default grant funds the READ tools and
  // nothing more — an act tool's scope is never in the default.
  const readScopes = new Set(pkg.tools.filter((t) => t.action === 'read').flatMap((t) => t.requiredScopes));
  const readOnlyActScopes = new Set(
    pkg.tools.filter((t) => t.action === 'act').flatMap((t) => t.requiredScopes),
  );
  for (const s of pkg.defaultScopes) {
    if (!readScopes.has(s)) {
      issues.push({
        code: 'default-scope-not-least-privilege',
        detail: `default scope '${s}' is not required by any READ tool`,
      });
    }
    if (readOnlyActScopes.has(s) && !readScopes.has(s)) {
      issues.push({ code: 'act-tool-scope-in-default', detail: `default scope '${s}' funds an act tool` });
    }
  }
  // Step 12 (T8): the check above only fires when the scope is act-ONLY, so
  // it was blind to the common case — an act sharing a scope the reads
  // already need. That is exactly when the default grant silently funds an
  // act, and it is what the mini-eval's least-privilege test now demands a
  // written vendor reason for. The validator says the same thing, so the
  // two instruments cannot drift apart.
  const granted = new Set(pkg.defaultScopes);
  for (const t of pkg.tools) {
    if (t.action !== 'act' || t.requiredScopes.length === 0) continue;
    if (!t.requiredScopes.every((s) => granted.has(s))) continue;
    if ((pkg.scopeLimits?.[t.name] ?? '').length < 30) {
      issues.push({
        code: 'funded-act-without-limit',
        detail: `act tool '${t.name}' is funded by the default grant with no scopeLimits reason`,
      });
    }
  }
  if (pkg.proof === 'fixture-recorded' && pkg.fixtureStamp === undefined) {
    issues.push({
      code: 'missing-fixture-stamp',
      detail: 'fixture-recorded requires capturedAt + serverVersion (review addition 3)',
    });
  }
  if (pkg.proof === 'live-proven' && !liveProvenIds.has(pkg.id)) {
    issues.push({
      code: 'unearned-live-proven',
      detail: 'live-proven requires a ledgered live run — no ledger entry for this package',
    });
  }
  if (pkg.injectionPayloads.length === 0) {
    issues.push({ code: 'no-injection-payloads', detail: 'package ships no hostile fixtures (§4)' });
  }
  return issues;
}

function toConnectorTools(pkg: SuperpowerPackage): Record<string, ConnectorToolDef> {
  const out: Record<string, ConnectorToolDef> = {};
  for (const t of pkg.tools) {
    out[t.name] = {
      scopes: t.requiredScopes,
      action: t.action,
      description: t.description,
      parameters: t.parameters,
    };
  }
  return out;
}

/**
 * Compile a package DOWN to the Step 10 ConnectorDef. Returns null when the
 * package is not `ready` — an unverified endpoint or unauthored OAuth makes
 * the package STRUCTURALLY unconnectable rather than quietly pointed at a
 * guessed URL. Mini-evals bypass this via toConnectorDefForFixture.
 */
export function toConnectorDef(pkg: SuperpowerPackage): ConnectorDef | null {
  if (pkg.connect.status !== 'ready') return null;
  return {
    connectorId: pkg.id,
    displayName: pkg.displayName,
    transport: pkg.transport,
    baseUrl: pkg.connect.baseUrl,
    oauth: pkg.connect.oauth,
    tools: toConnectorTools(pkg),
    usagePreamble: pkg.usage.preamble,
    ...(pkg.connect.revocationUrl !== undefined ? { revocationUrl: pkg.connect.revocationUrl } : {}),
  };
}

/**
 * The MINI-EVAL compile: the same authored tools pointed at a fixture
 * server, with placeholder OAuth env names. Every package — connectable or
 * not — is provable at $0 through this path, which is exactly why "packaged
 * and fixture-proven" is a weaker claim than "connectable" and both are
 * shown separately in the catalog.
 */
export function toConnectorDefForFixture(pkg: SuperpowerPackage, baseUrl: string): ConnectorDef {
  return {
    connectorId: pkg.id,
    displayName: pkg.displayName,
    transport: pkg.transport,
    baseUrl,
    oauth: {
      authorizationUrl: `${baseUrl}/authorize`,
      tokenUrl: `${baseUrl}/token`,
      clientIdEnv: 'POTION_FIXTURE_CLIENT_ID',
      clientSecretEnv: 'POTION_FIXTURE_CLIENT_SECRET',
      scopesOffered: pkg.defaultScopes,
    },
    tools: toConnectorTools(pkg),
    usagePreamble: pkg.usage.preamble,
  };
}

/** Days since a recorded fixture's capture — the staleness signal (§3). */
export function fixtureAgeDays(stamp: FixtureStamp, now: Date = new Date()): number {
  const captured = new Date(stamp.capturedAt).getTime();
  return Math.floor((now.getTime() - captured) / 86_400_000);
}
