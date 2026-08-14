// Connector definition — the shape the RUNTIME consumes (Step 10 §2,
// enriched by Step 11 §1). lab-mcp is CONNECTOR-AGNOSTIC: it holds no
// catalog. The curated catalog of superpower packages lives in
// @potion/lab-superpowers and compiles DOWN to this type
// (toConnectorDef), so the client machinery never learns a vendor's name.
//
// `tools` is an ALLOWLIST keyed by MCP tool name, and — since Step 11 —
// the SOLE SOURCE of every string that reaches the model for that tool:
//   · scopes      the subset rule against the grant (unchanged Step 10)
//   · action      'read' | 'act' → the before-external-action pore
//   · description AUTHORED text; REPLACES the server's tools/list prose
//   · parameters  AUTHORED JSON Schema; REPLACES the server's inputSchema
// A tool absent from the map NEVER reaches toolDefs (fail-closed — a tool
// whose requirements we cannot name is a tool the model cannot see).
//
// (Step 11 rename, recorded as a deviation: the field was `toolScopeMap`
// while it carried only scopes. It now carries action + description +
// parameters, so the old name lied; `tools` is what it is.)
export interface ConnectorOauth {
  authorizationUrl: string;
  tokenUrl: string;
  /** Env var names — the VALUES never live in code or db plaintext. */
  clientIdEnv: string;
  clientSecretEnv: string;
  /** What /oauth/start requests. EMPTY means a zero-scope grant — the
   * minimum a handshake allows (public read + identity). */
  scopesOffered: string[];
}

export interface ConnectorToolDef {
  /** Required OAuth scopes; ⊆ scopes_granted or the tool stays invisible. */
  scopes: string[];
  /** Step 11 §2: 'act' sets external:true (the pore fires); 'read' does
   * not. The RUNTIME defaults anything uncertain to 'act', fail-closed. */
  action: 'read' | 'act';
  /** AUTHORED. Curated, trusted, bounded — never the server's text. */
  description: string;
  /** AUTHORED JSON Schema. Never the server's inputSchema: parameter
   * descriptions travel into model context exactly like tool descriptions
   * do, so they get the same provenance rule. */
  parameters: Record<string, unknown>;
}

export interface ConnectorDef {
  connectorId: string;
  displayName: string;
  transport: 'streamable-http';
  baseUrl: string;
  oauth: ConnectorOauth;
  tools: Record<string, ConnectorToolDef>;
  /** AUTHORED capability guidance (Step 11 §7). Curated, trusted text that
   * enters the SYSTEM PROMPT when this connector's tools load — the "usage
   * instructions" half of the package format. Never server-supplied. */
  usagePreamble?: string;
  /** Provider-side revocation endpoint (best-effort, worker-only). The
   * `{clientId}` placeholder is substituted; the call is DELETE with basic
   * client auth and `{access_token}` in the body (the GitHub shape). */
  revocationUrl?: string;
}

/**
 * TEST/WALKTHROUGH seam — endpoint overrides so the OAuth flow and the MCP
 * session can run against an in-process mock provider at $0. Guarded by an
 * EXPLICIT opt-in (POTION_CONNECTOR_ENDPOINT_OVERRIDES=1): a stray env var
 * can never redirect a real token exchange, because without the opt-in the
 * catalog's endpoints are the only endpoints.
 */
export function withEndpointOverrides(
  c: ConnectorDef,
  env: NodeJS.ProcessEnv = process.env,
): ConnectorDef {
  if (env.POTION_CONNECTOR_ENDPOINT_OVERRIDES !== '1') return c;
  const prefix = `POTION_CONNECTOR_${c.connectorId.toUpperCase().replace(/-/g, '_')}`;
  return {
    ...c,
    baseUrl: env[`${prefix}_BASE_URL`] ?? c.baseUrl,
    oauth: {
      ...c.oauth,
      authorizationUrl: env[`${prefix}_AUTH_URL`] ?? c.oauth.authorizationUrl,
      tokenUrl: env[`${prefix}_TOKEN_URL`] ?? c.oauth.tokenUrl,
    },
  };
}

/** Namespaced LabTool name — collisions across connectors are structural,
 * and cap metering / grant-scope rollups key on the prefix. The parts come
 * from the CONNECTOR DEF (both sides authored), never from server text. */
export function toolNameFor(connectorId: string, mcpToolName: string): string {
  return `${connectorId}.${mcpToolName}`;
}

/**
 * The scope-filtered intersection (Step 10 §2, Step 11 direction flip):
 * iterate the PACKAGE's allowlist and keep the tools the server actually
 * offers — not the reverse. Same result set as before, but the returned
 * names are the AUTHORED keys, so no server string can ride along even as
 * an identifier (Step 11 review addition 1).
 */
export function grantedTools(
  connector: ConnectorDef,
  serverTools: Array<{ name: string }>,
  scopesGranted: string[],
): string[] {
  const granted = new Set(scopesGranted);
  const offered = new Set(serverTools.map((t) => t.name));
  return Object.entries(connector.tools)
    .filter(([name, def]) => offered.has(name) && def.scopes.every((s) => granted.has(s)))
    .map(([name]) => name);
}

/** The pore decision for one tool (Step 11 §2). A tool the connector does
 * not declare is UNCLASSIFIED → 'act', fail-closed: the pore fires. */
export function actionFor(connector: ConnectorDef, mcpToolName: string): 'read' | 'act' {
  return connector.tools[mcpToolName]?.action ?? 'act';
}

/** True when invoking the tool acts on the world outside the platform —
 * the LabTool.external flag, and therefore the pore. */
export function isExternalAction(connector: ConnectorDef, mcpToolName: string): boolean {
  return actionFor(connector, mcpToolName) === 'act';
}
