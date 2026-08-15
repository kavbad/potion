// Streamable-HTTP transport — the ONLY transport (Step 10 §2). JSON-RPC 2.0
// over POST; SSE response framing tolerated (a hosted server may answer a
// POST with an event stream). The transport union has NO stdio member and
// this package never touches child_process or a node:net listener — the
// fence test reads the source and fails on any reference: user-supplied
// server PROCESSES are structurally impossible, not merely disallowed.
//
// Timeouts fail typed (McpTransportError, kind 'timeout') — a slow hosted
// server degrades the superpower for the leg; it never hangs a run.

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpTransportError extends Error {
  constructor(
    readonly kind: 'timeout' | 'http' | 'protocol' | 'rpc',
    message: string,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

export interface StreamableHttpTransportOptions {
  baseUrl: string;
  /** Authorization bearer — the grant's access token. Lives only in this
   * object's header map, in process, for the session's lifetime. */
  accessToken?: string | undefined;
  timeoutMs?: number | undefined;
  /** Injectable for tests (the mock server hands its own fetch). */
  fetchImpl?: typeof fetch | undefined;
}

/** Parse an SSE body: the LAST `data:` payload wins (hosted servers stream
 * progress events before the response message). */
export function lastSseData(body: string): string | null {
  let last: string | null = null;
  let current: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      current.push(line.slice(5).trimStart());
    } else if (line === '' && current.length > 0) {
      last = current.join('\n');
      current = [];
    }
  }
  if (current.length > 0) last = current.join('\n');
  return last;
}

export class StreamableHttpTransport {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly accessToken: string | undefined;
  /** Mcp-Session-Id from initialize, echoed on every subsequent request. */
  sessionId: string | null = null;
  /** Pinned after initialize per the 2025-06-18 spec. */
  protocolVersion: string | null = null;
  private nextId = 1;

  constructor(opts: StreamableHttpTransportOptions) {
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.accessToken = opts.accessToken;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.accessToken !== undefined ? { authorization: `Bearer ${this.accessToken}` } : {}),
      ...(this.sessionId !== null ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion !== null ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }

  /** One JSON-RPC request → its result. Throws McpTransportError, typed. */
  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: this.nextId++, method, ...(params !== undefined ? { params } : {}) };
    const res = await this.post(req);
    if (res === null) throw new McpTransportError('protocol', `no response payload for '${method}'`);
    if (res.error !== undefined) {
      throw new McpTransportError('rpc', `MCP server error on '${method}': ${res.error.code} ${res.error.message}`);
    }
    return res.result;
  }

  /** Fire-and-forget notification (no id, no response expected). */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** Best-effort session teardown (spec: DELETE with the session id). */
  async close(): Promise<void> {
    if (this.sessionId === null) return;
    try {
      await this.fetchImpl(this.baseUrl, {
        method: 'DELETE',
        redirect: 'error',
        headers: this.headers(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // teardown is best-effort; the server expires idle sessions itself
    }
  }

  private async post(payload: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        // Step 12 (L6): fetch follows 3xx by default, which made the
        // hosted-only wall exactly one redirect wide — a connector could
        // answer with a Location pointing at loopback or an internal host
        // and our own client, holding the bearer, would follow it there.
        // A hosted MCP endpoint has no legitimate reason to move us: the
        // URL is the one the operator connected to, and a redirect is now
        // a typed transport error instead of a silent hop.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'TimeoutError') {
        throw new McpTransportError('timeout', `MCP request timed out after ${this.timeoutMs}ms`);
      }
      throw new McpTransportError('http', `MCP request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const sid = response.headers.get('mcp-session-id');
    if (sid !== null) this.sessionId = sid;
    if (response.status === 202) return null; // accepted notification
    if (!response.ok) {
      throw new McpTransportError('http', `MCP server returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    const raw = contentType.includes('text/event-stream') ? lastSseData(body) : body;
    if (raw === null || raw === '') {
      if (payload.id === undefined) return null; // notification with empty body
      throw new McpTransportError('protocol', 'empty response to a JSON-RPC request');
    }
    try {
      return JSON.parse(raw) as JsonRpcResponse;
    } catch {
      throw new McpTransportError('protocol', 'response is neither JSON nor SSE-framed JSON');
    }
  }
}
