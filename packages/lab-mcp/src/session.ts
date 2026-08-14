// Session lifecycle — per-LEG, never durable (Step 10 §2): open at leg
// start (initialize → initialized → tools/list), use for the leg's calls,
// close at leg end. Resume re-initializes; runs are the durable thing.
// Init failure is the CALLER's typed 'unreachable' degradation — this
// module throws McpTransportError and nothing else.
import { McpTransportError, type StreamableHttpTransport } from './transport.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, as the server declares it. */
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** Concatenated text content blocks (the v1 read — structured content
   * rides through verbatim in `raw` for callers that want it). */
  text: string;
  isError: boolean;
  raw: unknown;
}

export class McpSession {
  private constructor(
    private readonly transport: StreamableHttpTransport,
    readonly serverName: string,
    readonly tools: McpToolDef[],
  ) {}

  /** initialize → notifications/initialized → tools/list. */
  static async open(transport: StreamableHttpTransport): Promise<McpSession> {
    const init = (await transport.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'potion-lab', version: '0.1.0' },
    })) as { protocolVersion?: string; serverInfo?: { name?: string } };
    transport.protocolVersion = init.protocolVersion ?? MCP_PROTOCOL_VERSION;
    await transport.notify('notifications/initialized');
    const listed = (await transport.request('tools/list')) as { tools?: unknown };
    const tools: McpToolDef[] = Array.isArray(listed.tools)
      ? listed.tools.flatMap((t) => {
          const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
          if (typeof tool.name !== 'string') return [];
          return [
            {
              name: tool.name,
              description: typeof tool.description === 'string' ? tool.description : '',
              inputSchema:
                tool.inputSchema !== null && typeof tool.inputSchema === 'object'
                  ? (tool.inputSchema as Record<string, unknown>)
                  : { type: 'object' },
            },
          ];
        })
      : [];
    return new McpSession(transport, init.serverInfo?.name ?? 'unknown', tools);
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const result = (await this.transport.request('tools/call', {
      name,
      arguments: (args ?? {}) as Record<string, unknown>,
    })) as { content?: unknown; isError?: unknown };
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .map((b) => {
        const block = b as { type?: unknown; text?: unknown };
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .filter((t) => t !== '')
      .join('\n');
    return { text, isError: result.isError === true, raw: result };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

export { McpTransportError };
