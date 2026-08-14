// Connector catalog v1 (Step 10 §2) — a static registry of ONE reference
// connector. The 25-strong curated catalog is Step 11's exit, not this
// step's. toolScopeMap is an ALLOWLIST with scope requirements attached: a
// tool absent from the map NEVER reaches toolDefs (fail-closed — a tool
// whose requirements we cannot name is a tool the model cannot see), and a
// listed tool rides only when its required scopes ⊆ scopes_granted.
export interface ConnectorOauth {
  authorizationUrl: string;
  tokenUrl: string;
  /** Env var names — the VALUES never live in code or db plaintext. */
  clientIdEnv: string;
  clientSecretEnv: string;
  /** What /oauth/start requests. For GitHub this is EMPTY: a zero-scope
   * OAuth token is the minimum grant the handshake allows — public read +
   * identity, structurally incapable of writing. */
  scopesOffered: string[];
}

export interface ConnectorDef {
  connectorId: string;
  displayName: string;
  transport: 'streamable-http';
  baseUrl: string;
  oauth: ConnectorOauth;
  /** tool name → required OAuth scopes (subset rule against the grant). */
  toolScopeMap: Record<string, string[]>;
  /** Provider-side revocation endpoint (best-effort, worker-only). The
   * `{clientId}` placeholder is substituted; the call is DELETE with basic
   * client auth and `{access_token}` in the body (the GitHub shape). */
  revocationUrl?: string;
}

/** GitHub's hosted remote MCP server (the operator-chosen live connector).
 * Read-only tools only: the map lists no mutating tool, and the zero-scope
 * grant could not fund one anyway — two independent walls. */
export const GITHUB_CONNECTOR: ConnectorDef = {
  connectorId: 'github',
  displayName: 'GitHub',
  transport: 'streamable-http',
  baseUrl: 'https://api.githubcopilot.com/mcp/',
  oauth: {
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
    scopesOffered: [],
  },
  toolScopeMap: {
    get_me: [],
    search_repositories: [],
    search_code: [],
    search_issues: [],
    get_file_contents: [],
    list_issues: [],
    get_issue: [],
    list_pull_requests: [],
    get_pull_request: [],
    list_commits: [],
    get_commit: [],
  },
  revocationUrl: 'https://api.github.com/applications/{clientId}/grant',
};

export const CONNECTORS: readonly ConnectorDef[] = [GITHUB_CONNECTOR];

export function getConnector(connectorId: string): ConnectorDef | null {
  return CONNECTORS.find((c) => c.connectorId === connectorId) ?? null;
}

/**
 * TEST/WALKTHROUGH seam — endpoint overrides so the OAuth flow and the MCP
 * session can run against an in-process mock provider at $0. Guarded by an
 * EXPLICIT opt-in (POTION_CONNECTOR_ENDPOINT_OVERRIDES=1): a stray env var
 * can never redirect a real token exchange, because without the opt-in the
 * static registry endpoints are the only endpoints.
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
 * and cap metering / grant-scope rollups key on the prefix. */
export function toolNameFor(connectorId: string, mcpToolName: string): string {
  return `${connectorId}.${mcpToolName}`;
}

/** The scope-filtered intersection (Step 10 §2): server-declared tools ∩
 * the allowlist ∩ the grant. Returns the MCP tool names that may become
 * LabTools this leg. */
export function grantedTools(
  connector: ConnectorDef,
  serverTools: Array<{ name: string }>,
  scopesGranted: string[],
): string[] {
  const granted = new Set(scopesGranted);
  return serverTools
    .map((t) => t.name)
    .filter((name) => {
      const required = connector.toolScopeMap[name];
      if (required === undefined) return false; // unlisted = invisible
      return required.every((scope) => granted.has(scope));
    });
}
