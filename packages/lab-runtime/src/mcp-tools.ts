// The MCP → LabTool wrapper (Step 10 §2/§4) — redactor + caps between the
// wire and the loop; loop semantics unchanged (the pore, the gate, the
// wrap-up all already exist and fire exactly as before).
//
// Sessions are per-LEG: built here at leg start, closed by the caller at
// leg end; resume re-initializes. Every failure mode is a TYPED VALUE the
// model reads — this module never throws into the loop:
//   · grant expired / revoked / missing  → { superpowerUnavailable }
//   · session-init failure               → leg note { superpowerUnavailable:
//     'unreachable' } (recorded AND shown; run continues brain-only)
//   · cap crossing                       → { capExceeded } (kills the TOOL
//     for the run, never the run)
//   · transport/tool errors              → { toolError }
// Cap meters derive from the DURABLE step record (resume-correct by
// construction); the emitting model step is checkpointed before its tool
// runs, so attribution reads finished rows only.
//
// EVERY value returned to the loop passes the grant-value redactor FIRST,
// then the Step 3 secret gate scans the checkpoint (redaction before
// refusal — the pinned order).
import {
  getLabGrant,
  grantConnectionStatus,
  listLabSteps,
  listLabStepPayloadsForOrgSince,
  markLabGrantStatus,
  type PotionDb,
} from '@potion/db';
import { openGrantToken, sealRefreshedToken, type OpenGrant } from '@potion/custody';
import {
  attributedEstUsdForConnector,
  checkToolCaps,
  CONNECTORS,
  DEFAULT_TOOL_CAPS,
  grantedTools,
  grantValueRedactor,
  McpSession,
  StreamableHttpTransport,
  toolNameFor,
  truncateResult,
  withEndpointOverrides,
  type ConnectorDef,
  type Redactor,
  type ToolCapConfig,
} from '@potion/lab-mcp';
import type { HarnessSpec, HarnessSuperpower } from '@potion/lab-spec';
import type { LabTool } from './loop.js';

/** Refresh when the token dies within this window (or already did). */
export const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

export interface SuperpowerUnavailable {
  superpowerUnavailable: {
    connectorId: string;
    status: 'not-connected' | 'expired' | 'revoked' | 'unreachable';
    detail: string;
  };
}

export interface ToolCallError {
  toolError: { kind: string; detail: string };
}

export interface McpLegNote {
  toolName: string;
  note: SuperpowerUnavailable;
}

export interface McpLegSetupOptions {
  db: PotionDb;
  orgId: string;
  runId: string;
  masterKey: Buffer;
  spec: HarnessSpec;
  /** Registry override (tests point a connector at the mock server). */
  connectors?: readonly ConnectorDef[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface McpLegSetup {
  tools: LabTool[];
  /** Typed leg-start records: recorded as tool steps AND shown to the
   * model, so a dead superpower is never silently absent. */
  legNotes: McpLegNote[];
  close(): Promise<void>;
}

function capsFor(superpower: HarnessSuperpower): ToolCapConfig {
  return {
    ...DEFAULT_TOOL_CAPS,
    maxAttributedEstUsd: superpower.maxSpendUsdPerRun ?? null,
    maxAttributedEstUsdPerDay: superpower.maxSpendUsdPerDay ?? null,
  };
}

interface RefreshOutcome {
  ok: boolean;
  accessToken?: string;
  expiresAt?: Date;
  detail?: string;
}

/** OAuth refresh against the connector's token endpoint. Failure is a
 * typed outcome, never a throw — the caller marks the grant expired. */
async function refreshAccessToken(
  connector: ConnectorDef,
  grant: OpenGrant,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<RefreshOutcome> {
  if (grant.refreshToken === null) return { ok: false, detail: 'no refresh token held' };
  const clientId = env[connector.oauth.clientIdEnv];
  const clientSecret = env[connector.oauth.clientSecretEnv];
  if (clientId === undefined || clientSecret === undefined) {
    return { ok: false, detail: 'connector client credentials not configured' };
  }
  try {
    const res = await fetchImpl(connector.oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: grant.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, detail: `token endpoint HTTP ${res.status}` };
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (typeof body.access_token !== 'string') {
      // Do NOT echo body.error — a compromised token endpoint controls that
      // field and it lands in a leg note (checkpoint + model context). The
      // failure REASON is what the operator needs; the provider's raw text
      // is not worth the untrusted-string path (Step 10 review hardening).
      return { ok: false, detail: 'token endpoint refused the refresh (no access_token returned)' };
    }
    return {
      ok: true,
      accessToken: body.access_token,
      ...(typeof body.expires_in === 'number'
        ? { expiresAt: new Date(Date.now() + body.expires_in * 1000) }
        : {}),
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function buildMcpLabTools(opts: McpLegSetupOptions): Promise<McpLegSetup> {
  const env = opts.env ?? process.env;
  const connectors = (opts.connectors ?? CONNECTORS).map((c) => withEndpointOverrides(c, env));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const tools: LabTool[] = [];
  const legNotes: McpLegNote[] = [];
  const sessions: McpSession[] = [];
  const heldSecrets: Array<string | null> = [];

  const note = (
    connectorId: string,
    status: SuperpowerUnavailable['superpowerUnavailable']['status'],
    detail: string,
  ): void => {
    legNotes.push({
      toolName: `mcp:${connectorId}`,
      note: { superpowerUnavailable: { connectorId, status, detail } },
    });
  };

  // If any connector's setup THROWS mid-loop (e.g. a tampered envelope →
  // CustodyDecryptError), close the sessions already opened before
  // rethrowing — a thrown build must not leak live HTTP sessions (Step 10
  // review hardening; the happy path returns close() as usual).
  try {
  for (const superpower of opts.spec.superpowers) {
    const connector = connectors.find((c) => c.connectorId === superpower.id);
    if (connector === undefined) continue; // no catalog entry — stays not-connected (Step 8 posture)
    const grant = await openGrantToken(opts.db, opts.masterKey, opts.orgId, connector.connectorId);
    if (grant === null) continue; // not-connected — the DTO already says so
    if (grant.status === 'revoked') {
      note(connector.connectorId, 'revoked', 'grant revoked — the operator cut this connection');
      continue;
    }
    if (grant.status === 'expired') {
      note(connector.connectorId, 'expired', 'grant expired — reconnect to heal the filament');
      continue;
    }

    // ---- expiry / refresh (before session init) ----
    let accessToken = grant.accessToken;
    if (
      grant.tokenExpiresAt !== null &&
      grant.tokenExpiresAt.getTime() <= now().getTime() + TOKEN_REFRESH_WINDOW_MS
    ) {
      const refreshed = await refreshAccessToken(connector, grant, fetchImpl, env);
      if (!refreshed.ok) {
        await markLabGrantStatus(opts.db, opts.orgId, connector.connectorId, 'expired', now());
        note(connector.connectorId, 'expired', `token refresh failed: ${refreshed.detail ?? '?'}`);
        continue;
      }
      accessToken = refreshed.accessToken!;
      await sealRefreshedToken(
        opts.db,
        opts.masterKey,
        opts.orgId,
        connector.connectorId,
        accessToken,
        refreshed.expiresAt ?? null,
      );
    }

    // ---- session per leg ----
    let session: McpSession;
    try {
      const transport = new StreamableHttpTransport({
        baseUrl: connector.baseUrl,
        accessToken,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
      });
      session = await McpSession.open(transport);
    } catch (e) {
      note(
        connector.connectorId,
        'unreachable',
        `session init failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    sessions.push(session);
    heldSecrets.push(accessToken, grant.refreshToken);

    // ---- discovery ∩ allowlist ∩ granted scopes ----
    const allowed = new Set(grantedTools(connector, session.tools, grant.scopesGranted));
    const caps = capsFor(superpower);
    for (const mcpTool of session.tools) {
      if (!allowed.has(mcpTool.name)) continue; // invisible, not refused
      const labName = toolNameFor(connector.connectorId, mcpTool.name);
      tools.push({
        name: labName,
        description: mcpTool.description,
        parameters: mcpTool.inputSchema,
        external: true, // v1: EVERY MCP tool gates on the pore (relaxation is Step 11 posture)
        run: makeToolRun({
          db: opts.db,
          orgId: opts.orgId,
          runId: opts.runId,
          connectorId: connector.connectorId,
          mcpToolName: mcpTool.name,
          labName,
          session,
          caps,
          redact: () => redactor,
          now,
        }),
      });
    }
  }
  } catch (e) {
    await Promise.all(sessions.map((s) => s.close().catch(() => {})));
    throw e;
  }

  // ONE redactor over every held secret of the leg — built after all grants
  // opened so cross-connector echoes die too.
  const redactor = grantValueRedactor(heldSecrets);

  return {
    tools,
    legNotes,
    close: async () => {
      await Promise.all(sessions.map((s) => s.close().catch(() => {})));
    },
  };
}

function makeToolRun(deps: {
  db: PotionDb;
  orgId: string;
  runId: string;
  connectorId: string;
  mcpToolName: string;
  labName: string;
  session: McpSession;
  caps: ToolCapConfig;
  redact: () => Redactor;
  now: () => Date;
}): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    const redact = deps.redact();
    // ---- mid-run revocation/expiry: typed, never silent, never a crash ----
    const status = grantConnectionStatus(
      await getLabGrant(deps.db, deps.orgId, deps.connectorId),
      deps.now(),
    );
    if (status !== 'connected') {
      if (status === 'expired') {
        await markLabGrantStatus(deps.db, deps.orgId, deps.connectorId, 'expired', deps.now());
      }
      const result: SuperpowerUnavailable = {
        superpowerUnavailable: {
          connectorId: deps.connectorId,
          status,
          detail:
            status === 'revoked'
              ? 'grant revoked mid-run — the operator cut this connection'
              : status === 'expired'
                ? 'grant expired mid-run'
                : 'grant no longer present',
        },
      };
      return result;
    }
    // ---- caps, from the durable record, BEFORE the call executes ----
    // callCount / resultBytes meter per-tool; the DOLLAR caps meter at GRANT
    // scope (summed over the connector's tools) so the operator's per-
    // connection budget is one ceiling, not one-per-tool (Step 10 review).
    const steps = await listLabSteps(deps.db, deps.runId, deps.orgId);
    const runUsd =
      deps.caps.maxAttributedEstUsd !== null
        ? attributedEstUsdForConnector(steps, deps.connectorId)
        : 0;
    let dayUsd = 0;
    if (deps.caps.maxAttributedEstUsdPerDay !== null) {
      const dayStart = new Date(deps.now());
      dayStart.setUTCHours(0, 0, 0, 0);
      dayUsd = attributedEstUsdForConnector(
        await listLabStepPayloadsForOrgSince(deps.db, deps.orgId, dayStart),
        deps.connectorId,
      );
    }
    const refusal = checkToolCaps(steps, deps.labName, deps.caps, dayUsd, runUsd);
    if (refusal !== null) return refusal;
    // ---- the call ----
    let result;
    try {
      result = await deps.session.callTool(deps.mcpToolName, input);
    } catch (e) {
      const kind = (e as { kind?: string }).kind ?? 'error';
      if (kind === 'http' && /HTTP 401/.test(e instanceof Error ? e.message : '')) {
        // provider rejected the token mid-run: locally active, remotely
        // dead — the typed 'expired' state, durable + visible.
        await markLabGrantStatus(deps.db, deps.orgId, deps.connectorId, 'expired', deps.now());
        return redact({
          superpowerUnavailable: {
            connectorId: deps.connectorId,
            status: 'expired',
            detail: 'provider rejected the token mid-run',
          },
        } satisfies SuperpowerUnavailable);
      }
      return redact({
        toolError: { kind, detail: e instanceof Error ? e.message : String(e) },
      } satisfies ToolCallError);
    }
    if (result.isError) {
      return redact({ toolError: { kind: 'server-error', detail: result.text.slice(0, 2_000) } });
    }
    // ---- redact FIRST (full text), then truncate typed ----
    const clean = redact(result.text);
    return truncateResult(clean, deps.caps.maxPerCallBytes);
  };
}
