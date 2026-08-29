// BYO-MCP (2026-08-28) — a registered custom endpoint compiled to the
// runtime's ConnectorDef. The provenance rule bends here in exactly one
// authorized way: the tool text is not Potion-authored, it is the PINNED
// surface an org ADMIN reviewed and accepted at registration (the probe on
// the server side enforced caps + custody scans before they ever saw it).
// The admin's confirmation makes them the author. Two invariants hold
// regardless: every tool is an ACT (fail-closed — the pore fires until that
// kind of action earns autonomy), and the surface is FROZEN at the pin —
// the live server's tools/list is never re-read into model context.
import type { ConnectorDef } from './registry.js';

/** Structural twin of the db row — lab-mcp stays dependency-free of db. */
export interface CustomConnectorSource {
  connectorId: string;
  displayName: string;
  endpointUrl: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export function customConnectorDef(row: CustomConnectorSource): ConnectorDef {
  const tools: ConnectorDef['tools'] = {};
  for (const t of row.tools) {
    tools[t.name] = {
      scopes: [],
      action: 'act',
      description: t.description,
      parameters: t.inputSchema,
    };
  }
  return {
    connectorId: row.connectorId,
    displayName: row.displayName,
    transport: 'streamable-http',
    baseUrl: row.endpointUrl,
    // No OAuth flow exists for a BYO endpoint — the bearer (when given)
    // was sealed into the grant at registration; these fields are inert.
    oauth: { authorizationUrl: '', tokenUrl: '', clientIdEnv: '', clientSecretEnv: '', scopesOffered: [] },
    tools,
    usagePreamble: `${row.displayName}: the org's own MCP endpoint, surface pinned at registration. Every call asks the operator first until that kind of action earns autonomy.`,
  };
}
