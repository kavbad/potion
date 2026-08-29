// BYO-MCP (2026-08-28) — the probe and the pinning. An admin registers
// their own MCP endpoint; Potion opens ONE session (initialize →
// tools/list), pins the declared surface under caps and custody scanning,
// and the admin's confirmation makes them the AUTHOR of that text (the
// provenance rule holds: nothing enters model context that a human in the
// org did not accept). Every pinned tool classifies fail-closed as an ACT.
import { checkUrl } from '@potion/lab-runtime';
import { scanRawValue } from '@potion/lab-spec';
import { McpSession, StreamableHttpTransport } from '@potion/lab-mcp';

export const PROBE_LIMITS = {
  MAX_TOOLS: 40,
  MAX_DESCRIPTION_CHARS: 400,
  MAX_SCHEMA_BYTES: 4_000,
  MAX_NAME_CHARS: 80,
  TIMEOUT_MS: 10_000,
} as const;

export const CUSTOM_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export interface ProbedSurface {
  serverName: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export type ProbeResult = { ok: true; surface: ProbedSurface } | { ok: false; reason: string };

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  /** Tests only: overrides DNS inside the SSRF check so no test touches the
   * network. Production callers leave it unset — real resolution guards. */
  lookupImpl?: (host: string) => Promise<{ address: string; family?: number }>;
}

export async function probeMcpEndpoint(
  url: string,
  bearerToken: string | undefined,
  deps: ProbeDeps = {},
): Promise<ProbeResult> {
  const verdict = await checkUrl(url, deps.lookupImpl !== undefined ? { lookupImpl: deps.lookupImpl } : {});
  if (!verdict.ok) return { ok: false, reason: `endpoint refused: ${verdict.reason}` };
  let session: McpSession | null = null;
  try {
    const transport = new StreamableHttpTransport({
      baseUrl: url,
      timeoutMs: PROBE_LIMITS.TIMEOUT_MS,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(bearerToken !== undefined && bearerToken !== '' ? { accessToken: bearerToken } : {}),
    });
    session = await McpSession.open(transport);
  } catch (e) {
    // Typed reason, never the server's own error text verbatim into a UI
    // that trusts it — name the failure class only.
    return { ok: false, reason: `could not open an MCP session: ${e instanceof Error ? e.name : 'error'}` };
  }
  try {
    if (session.tools.length === 0) return { ok: false, reason: 'the server declared no tools' };
    if (session.tools.length > PROBE_LIMITS.MAX_TOOLS) {
      return { ok: false, reason: `the server declares ${session.tools.length} tools — the cap is ${PROBE_LIMITS.MAX_TOOLS}` };
    }
    const tools: ProbedSurface['tools'] = [];
    for (const t of session.tools) {
      if (t.name.length > PROBE_LIMITS.MAX_NAME_CHARS || !/^[A-Za-z0-9_.-]+$/.test(t.name)) {
        return { ok: false, reason: `tool name '${t.name.slice(0, 40)}…' refused (length/charset)` };
      }
      const description = t.description.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, PROBE_LIMITS.MAX_DESCRIPTION_CHARS);
      const schemaText = JSON.stringify(t.inputSchema);
      const schema: Record<string, unknown> =
        Buffer.byteLength(schemaText, 'utf8') > PROBE_LIMITS.MAX_SCHEMA_BYTES ? { type: 'object' } : t.inputSchema;
      // Custody at the pin: key-shaped content in a declared surface is a
      // refusal — a tool description is no place for a credential.
      const hits = scanRawValue({ description, schema }).filter((i) => i.code === 'secret-material');
      if (hits.length > 0) return { ok: false, reason: `tool '${t.name}' declares key-shaped content — refused` };
      tools.push({ name: t.name, description, inputSchema: schema });
    }
    const serverName = session.serverName.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
    return { ok: true, surface: { serverName, tools } };
  } finally {
    await session.close().catch(() => {});
  }
}

// The row→ConnectorDef compiler lives in @potion/lab-mcp (workers use it
// too and must not import the server app).
export { customConnectorDef } from '@potion/lab-mcp';
