// Session lifecycle against the mock hosted server — a REAL wire, not an
// object double: initialize → initialized → tools/list, bearer on every
// request, session id echoed, SSE framing tolerated, timeout typed,
// scope filtering structural.
import { afterEach, describe, expect, it } from 'vitest';
import { MockMcpServer } from './mock-server.js';
import { McpSession } from './session.js';
import { lastSseData, McpTransportError, StreamableHttpTransport } from './transport.js';
import { actionFor, grantedTools, isExternalAction, toolNameFor, type ConnectorDef } from './registry.js';

const TOOLS = [
  { name: 'get_me', description: 'who am I', handler: () => ({ login: 'kavon' }) },
  { name: 'delete_repo', description: 'destructive', handler: () => 'gone' },
];

let server: MockMcpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function open(opts: Partial<Parameters<typeof MockMcpServer.start>[0]> = {}) {
  server = await MockMcpServer.start({ tools: TOOLS, ...opts });
  const transport = new StreamableHttpTransport({
    baseUrl: server.mcpUrl,
    accessToken: 'gho_sessionTESTtoken1234567890abcdef',
  });
  return { session: await McpSession.open(transport), transport };
}

describe('McpSession', () => {
  it('initialize → initialized → tools/list, with the bearer on EVERY request', async () => {
    const { session } = await open();
    expect(session.serverName).toBe('mock-mcp');
    expect(session.tools.map((t) => t.name)).toEqual(['get_me', 'delete_repo']);
    expect(server!.requests.map((r) => r.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    for (const r of server!.requests) {
      expect(r.authorization).toBe('Bearer gho_sessionTESTtoken1234567890abcdef');
    }
  });

  it('carries the server session id after initialize', async () => {
    const { session, transport } = await open();
    expect(transport.sessionId).toBe('mock-session-1');
    await session.callTool('get_me', {});
    expect(server!.requests.at(-1)!.sessionId).toBe('mock-session-1');
  });

  it('callTool returns concatenated text blocks', async () => {
    const { session } = await open();
    const result = await session.callTool('get_me', {});
    expect(result.text).toBe(JSON.stringify({ login: 'kavon' }));
    expect(result.isError).toBe(false);
  });

  it('tolerates SSE response framing (hosted servers may stream)', async () => {
    const { session } = await open({ sse: true });
    const result = await session.callTool('get_me', {});
    expect(result.text).toBe(JSON.stringify({ login: 'kavon' }));
  });

  it('init failure throws typed — the caller degrades the superpower, never crashes the run', async () => {
    server = await MockMcpServer.start({ tools: TOOLS, failInitialize: true });
    const transport = new StreamableHttpTransport({ baseUrl: server.mcpUrl });
    await expect(McpSession.open(transport)).rejects.toThrow(McpTransportError);
  });

  it('a 401 (revoked/expired provider-side) is a typed http error', async () => {
    server = await MockMcpServer.start({ tools: TOOLS, requireBearer: 'gho_theRIGHTtoken' });
    const transport = new StreamableHttpTransport({ baseUrl: server.mcpUrl, accessToken: 'gho_theWRONGtoken' });
    await expect(McpSession.open(transport)).rejects.toThrow(/HTTP 401/);
  });

  it('timeouts are typed, not hangs', async () => {
    server = await MockMcpServer.start({ tools: TOOLS });
    const never = () => new Promise<Response>(() => {});
    const transport = new StreamableHttpTransport({
      baseUrl: server.mcpUrl,
      timeoutMs: 50,
      fetchImpl: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        init?.signal
          ? new Promise<Response>((_, reject) => {
              init.signal!.addEventListener('abort', () =>
                reject(new DOMException('timed out', 'TimeoutError')),
              );
            })
          : never()) as typeof fetch,
    });
    await expect(transport.request('initialize', {})).rejects.toThrow(/timed out after 50ms/);
  });
});

describe('scope filtering (structural, before toolDefs)', () => {
  const tool = (scopes: string[], action: 'read' | 'act'): ConnectorDef['tools'][string] => ({
    scopes,
    action,
    description: 'authored',
    parameters: { type: 'object' },
  });
  const connector: ConnectorDef = {
    connectorId: 'testconn',
    displayName: 'Test',
    transport: 'streamable-http',
    baseUrl: 'https://unused.example',
    oauth: {
      authorizationUrl: 'https://unused.example/auth',
      tokenUrl: 'https://unused.example/token',
      clientIdEnv: 'X_ID',
      clientSecretEnv: 'X_SECRET',
      scopesOffered: ['read', 'write'],
    },
    tools: {
      read_item: tool(['read'], 'read'),
      write_item: tool(['write'], 'act'),
      list_items: tool([], 'read'),
    },
  };

  it('a tool outside the granted scopes NEVER enters the granted list', () => {
    const serverTools = [{ name: 'read_item' }, { name: 'write_item' }, { name: 'list_items' }];
    expect(grantedTools(connector, serverTools, ['read']).sort()).toEqual(['list_items', 'read_item']);
  });

  it('a tool ABSENT from the allowlist is invisible even when the server offers it', () => {
    const serverTools = [{ name: 'read_item' }, { name: 'rm_rf_everything' }];
    expect(grantedTools(connector, serverTools, ['read', 'write'])).toEqual(['read_item']);
  });

  it('a declared tool the server does NOT offer is skipped (no phantom tools)', () => {
    expect(grantedTools(connector, [{ name: 'read_item' }], ['read', 'write'])).toEqual(['read_item']);
  });

  it('tool names are namespaced by connector', () => {
    expect(toolNameFor('github', 'get_me')).toBe('github.get_me');
  });

  it('action classification drives the pore; UNDECLARED defaults to act, fail-closed', () => {
    expect(actionFor(connector, 'read_item')).toBe('read');
    expect(isExternalAction(connector, 'read_item')).toBe(false);
    expect(actionFor(connector, 'write_item')).toBe('act');
    expect(isExternalAction(connector, 'write_item')).toBe(true);
    // a tool the connector never declared: the pore fires
    expect(actionFor(connector, 'mystery_tool')).toBe('act');
    expect(isExternalAction(connector, 'mystery_tool')).toBe(true);
  });
});

describe('lastSseData', () => {
  it('takes the LAST complete data payload', () => {
    expect(lastSseData('data: {"a":1}\n\ndata: {"b":2}\n\n')).toBe('{"b":2}');
    expect(lastSseData('event: message\ndata: {"x":1}\n\n')).toBe('{"x":1}');
    expect(lastSseData('data: line1\ndata: line2\n\n')).toBe('line1\nline2');
    expect(lastSseData('no data here')).toBeNull();
  });
});
