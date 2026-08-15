// In-process mock MCP server — the TEST DOUBLE for a hosted streamable-HTTP
// server (the oidc.test.ts fake-IdP pattern). Used by this package's tests,
// the runtime integration tests, and the walkthrough's $0 connect leg.
//
// FENCE NOTE: this file is the ONE deliberate listener in the package and
// the fence test exempts it BY NAME with this reason: it plays the remote
// hosted server so the client can be proven against a wire, it is exported
// only through the './mock-server' subpath (never the main index), and no
// client module imports it. The client surface itself remains structurally
// incapable of running or listening for a server.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JsonRpcRequest } from './transport.js';

export interface MockMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** A string becomes one text content block; an object is JSON-stringified
   * into one; `{ __rawResult }` passes through verbatim as tools/call's
   * result (for malformed/hostile fixtures); `{ __rpcError }` fails the call
   * at the JSON-RPC layer with that server-chosen message. */
  handler: (args: Record<string, unknown>) => unknown;
}

export interface MockMcpServerOptions {
  tools: MockMcpTool[];
  /** 401 every MCP request unless the bearer matches (expiry fixtures). */
  requireBearer?: string;
  /** Fail `initialize` with an RPC error (unreachable-degradation tests). */
  failInitialize?: boolean;
  /** Initialize fine, then fail `tools/list` with THIS server-controlled
   * error message — the Step 11 review's untrusted-string path (a JSON-RPC
   * error `message` is attacker text that used to ride into a leg note). */
  failToolsList?: string;
  /** Frame every response as text/event-stream (SSE tolerance tests). */
  sse?: boolean;
  /** Scripted OAuth token endpoint at POST /token (refresh fixtures). */
  tokenEndpoint?: (form: Record<string, string>) => { status: number; body: unknown };
}

export interface SeenRequest {
  method: string;
  params: unknown;
  authorization: string | null;
  sessionId: string | null;
}

export class MockMcpServer {
  readonly requests: SeenRequest[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
    private readonly opts: MockMcpServerOptions,
  ) {}

  get mcpUrl(): string {
    return `${this.url}/mcp`;
  }

  get tokenUrl(): string {
    return `${this.url}/token`;
  }

  static async start(opts: MockMcpServerOptions): Promise<MockMcpServer> {
    // Mutable holder: the request handler closes over the box, not the
    // instance, so the instance itself is assigned exactly once (const).
    const ref: { current: MockMcpServer | null } = { current: null };
    const server = createServer((req, res) => void ref.current!.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const instance = new MockMcpServer(server, `http://127.0.0.1:${port}`, opts);
    ref.current = instance;
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }

  private respond(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
    const body = JSON.stringify(payload);
    if (this.opts.sse && status === 200) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      res.end(`event: message\ndata: ${body}\n\n`);
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const url = req.url ?? '/';

    if (url.endsWith('/token') && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(bodyText));
      const scripted = this.opts.tokenEndpoint?.(form) ?? {
        status: 400,
        body: { error: 'unsupported_grant_type' },
      };
      this.respond(res, scripted.status, scripted.body);
      return;
    }

    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const auth = req.headers.authorization ?? null;
    if (this.opts.requireBearer !== undefined && auth !== `Bearer ${this.opts.requireBearer}`) {
      this.respond(res, 401, { error: 'unauthorized' });
      return;
    }

    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(bodyText) as JsonRpcRequest;
    } catch {
      this.respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    this.requests.push({
      method: rpc.method,
      params: rpc.params ?? null,
      authorization: auth,
      sessionId: (req.headers['mcp-session-id'] as string | undefined) ?? null,
    });

    if (rpc.id === undefined) {
      res.writeHead(202).end(); // notification
      return;
    }

    const reply = (result: unknown): void =>
      this.respond(res, 200, { jsonrpc: '2.0', id: rpc.id, result }, { 'mcp-session-id': 'mock-session-1' });
    const rpcError = (code: number, message: string): void =>
      this.respond(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });

    switch (rpc.method) {
      case 'initialize':
        if (this.opts.failInitialize === true) {
          rpcError(-32603, 'scripted initialize failure');
          return;
        }
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '0.0.1' },
        });
        return;
      case 'tools/list':
        if (this.opts.failToolsList !== undefined) {
          rpcError(-32000, this.opts.failToolsList);
          return;
        }
        reply({
          tools: this.opts.tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object' },
          })),
        });
        return;
      case 'tools/call': {
        const params = rpc.params as { name?: string; arguments?: Record<string, unknown> };
        const tool = this.opts.tools.find((t) => t.name === params.name);
        if (tool === undefined) {
          rpcError(-32602, `unknown tool '${params.name ?? '?'}'`);
          return;
        }
        const out = tool.handler(params.arguments ?? {});
        // `{ __rpcError }` fails the CALL at the JSON-RPC layer with a
        // server-chosen message — the Step 12 (L1) path, where an attacker's
        // prose used to ride McpTransportError.message into the model's
        // conversation through toolError.detail.
        if (out !== null && typeof out === 'object' && '__rpcError' in out) {
          rpcError(-32000, String((out as { __rpcError: unknown }).__rpcError));
          return;
        }
        if (out !== null && typeof out === 'object' && '__rawResult' in out) {
          reply((out as { __rawResult: unknown }).__rawResult);
          return;
        }
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        reply({ content: [{ type: 'text', text }], isError: false });
        return;
      }
      default:
        rpcError(-32601, `method '${rpc.method}' not found`);
    }
  }
}
