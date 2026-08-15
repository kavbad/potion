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
  createReassemblySentinel,
  DEFAULT_TOOL_CAPS,
  grantedTools,
  grantValueRedactor,
  isExternalAction,
  McpSession,
  McpTransportError,
  StreamableHttpTransport,
  toolNameFor,
  truncateResult,
  withEndpointOverrides,
  type ConnectorDef,
  type ReassemblySentinel,
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

/** The typed value a severed connector returns for the rest of the leg
 * (Step 12, T5/T6). Authored text, no server string, no secret material —
 * and deliberately the SAME value for the tripping call and every call
 * after it, so a server cannot use the difference as an oracle for how
 * much of its shard budget it has left. */
export const SEVERED_RESULT: ToolCallError = {
  toolError: {
    kind: 'custody-severed',
    detail:
      'this connection was cut mid-run: its results were reassembling credential material. No further calls will run this leg.',
  },
};

/** AUTHORED failure prose for a transport-level error, keyed by the typed
 * kind alone (Step 12 L1). The model needs to know the call failed and
 * whether retrying is plausible; it does not need — and must not receive —
 * the connector's own words. */
function transportDetail(kind: string): string {
  switch (kind) {
    case 'timeout':
      return 'the connector did not answer in time';
    case 'http':
      return 'the connector refused the request at the transport level';
    case 'protocol':
      return 'the connector answered in a shape this client does not accept';
    case 'rpc':
      return 'the connector reported an error for this call';
    default:
      return 'the call to the connector failed';
  }
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
  /** Step 11 §7 (review finding): the AUTHORED usage preambles of the
   * connectors whose tools actually loaded — the "usage instructions" half
   * of the package format, threaded into the system prompt. Without this
   * the preamble was charged against the token budget and shown in the DTO
   * while reaching nothing. */
  guidance: string[];
  /** Typed leg-start records: recorded as tool steps AND shown to the
   * model, so a dead superpower is never silently absent. */
  legNotes: McpLegNote[];
  close(): Promise<void>;
}

function capsFor(superpower: HarnessSuperpower): ToolCapConfig {
  return {
    ...DEFAULT_TOOL_CAPS,
    // Step 12: an authored call ceiling overrides the library default.
    ...(superpower.maxCalls !== undefined ? { maxCalls: superpower.maxCalls } : {}),
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
    // Step 12 (L11): this is the LAST untrusted string on the leg-note path.
    // The note it feeds is built BEFORE heldSecrets is populated for this
    // connector, so the leg redactor holds nothing for it — and the message
    // here is network/DNS/TLS text shaped by the connector's own hostname
    // and, for a hostile token endpoint, its own response. The note carries
    // the typed REASON; the operator still gets the detail through the
    // worker log, which is not model context.
    void e;
    return { ok: false, detail: 'the token endpoint could not be reached' };
  }
}

export async function buildMcpLabTools(opts: McpLegSetupOptions): Promise<McpLegSetup> {
  const env = opts.env ?? process.env;
  const connectors = (opts.connectors ?? []).map((c) => withEndpointOverrides(c, env));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const tools: LabTool[] = [];
  const guidance: string[] = [];
  const legNotes: McpLegNote[] = [];
  const sessions: McpSession[] = [];
  const heldSecrets: Array<string | null> = [];
  /** Connectors the reassembly sentinel cut mid-leg (Step 12, T5/T6). */
  const severed = new Set<string>();

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
      // Step 11 review finding: the thrown message EMBEDS server-controlled
      // text (a JSON-RPC error's `message` — transport.ts), and a leg note
      // lands in both the checkpoint and the model's conversation. So the
      // note carries the TYPED failure kind only, never the server's string
      // — the same refusal already applied to the token endpoint's `error`
      // field above. The full error still surfaces to operators through the
      // job/worker log; it just never becomes model context.
      const kind = e instanceof McpTransportError ? e.kind : 'error';
      note(connector.connectorId, 'unreachable', `session init failed (${kind})`);
      continue;
    }
    sessions.push(session);
    heldSecrets.push(accessToken, grant.refreshToken);

    // ---- discovery ∩ allowlist ∩ granted scopes ----
    //
    // Step 11 (review addition 1): the iteration runs over the CONNECTOR's
    // authored allowlist, and the server's tools/list is consulted only for
    // EXISTENCE (grantedTools intersects the two). Consequently NO
    // server-supplied string reaches the model — not the tool name, not the
    // description, not the parameter schema (whose `description` fields
    // travel the same path into context). The server's own strings are
    // recorded as DATA in the session and never forwarded.
    //
    // Step 11 §2: `external` is now the tool's ACTION CLASSIFICATION —
    // 'act' fires the before-external-action pore, 'read' does not; a tool
    // the connector never declared is unclassified and defaults to 'act',
    // fail-closed (isExternalAction).
    const allowed = grantedTools(connector, session.tools, grant.scopesGranted);
    const caps = capsFor(superpower);
    if (allowed.length > 0 && connector.usagePreamble !== undefined) {
      guidance.push(connector.usagePreamble);
    }
    for (const mcpToolName of allowed) {
      const authored = connector.tools[mcpToolName]!;
      const labName = toolNameFor(connector.connectorId, mcpToolName);
      tools.push({
        name: labName,
        description: authored.description,
        parameters: authored.parameters,
        external: isExternalAction(connector, mcpToolName),
        run: makeToolRun({
          db: opts.db,
          orgId: opts.orgId,
          runId: opts.runId,
          connectorId: connector.connectorId,
          mcpToolName,
          labName,
          session,
          caps,
          redact: () => redactor,
          sentinel: () => sentinel,
          severed,
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
  // Step 12 (T5/T6): and ONE sentinel behind it, stateful for the whole
  // leg, watching what the stateless scrub could not — sub-threshold shards
  // accumulating across separate results into a whole credential.
  const sentinel = createReassemblySentinel(heldSecrets);

  return {
    tools,
    guidance,
    // Step 11 review finding: leg notes were the ONE model-facing value that
    // never passed the redactor (it is built after this loop). They do now —
    // a connector that echoes its bearer inside a failure path cannot write
    // the live token into the run record or the conversation.
    legNotes: legNotes.map((n) => ({ toolName: n.toolName, note: redactor(n.note) })),
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
  sentinel: () => ReassemblySentinel;
  /** Connectors severed mid-leg by the sentinel — leg-local, shared by
   * every tool of every connector (a trip cuts the one that did it). */
  severed: Set<string>;
  now: () => Date;
}): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    const redact = deps.redact();
    if (deps.severed.has(deps.connectorId)) return SEVERED_RESULT;
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
      // Step 12 finding L5 (HIGH) — the SIBLING the spec predicted (§3, "the
      // transport's typed error paths ... assume siblings"). `e.message` for
      // an McpTransportError of kind 'rpc' EMBEDS the server's own
      // `error.message` (transport.ts) — so a hostile connector wrote
      // attacker-chosen prose straight into the conversation and the durable
      // checkpoint, through the one path Step 11's leg-note fix did not
      // cover. The rule the build already applies to notes applies here: the
      // model gets the TYPED kind, never the server's string. Operators keep
      // the full message through the worker log.
      return redact({
        toolError: { kind, detail: transportDetail(kind) },
      } satisfies ToolCallError);
    }
    if (result.isError) {
      return redact({ toolError: { kind: 'server-error', detail: result.text.slice(0, 2_000) } });
    }
    // ---- redact FIRST (full text), then truncate typed ----
    const clean = redact(result.text);
    // ---- then the leg-stateful reassembly check (Step 12, T5/T6) ----
    // The sentinel reads what SURVIVED the scrub. If this result carries the
    // shard that pushes a held secret over the threshold, the result is
    // withheld — the model never sees it — and the connector is cut for the
    // rest of the leg. Fail closed: a connector caught assembling a
    // credential across results does not get another result.
    const trip = deps.sentinel().observe(clean);
    if (trip !== null) {
      deps.severed.add(deps.connectorId);
      return SEVERED_RESULT;
    }
    return truncateResult(clean, deps.caps.maxPerCallBytes);
  };
}
