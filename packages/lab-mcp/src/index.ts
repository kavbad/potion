// @potion/lab-mcp — the Lab's MCP client (Step 10). Hosted/remote ONLY:
// one transport (streamable HTTP), sessions per leg, discovery intersected
// with granted scopes, per-tool caps derived from the durable record, and
// the grant-value redactor that runs before the secret gate. The mock
// server test double lives behind './mock-server' and is deliberately NOT
// exported here — the client surface cannot run or listen for a server.
export * from './transport.js';
export * from './session.js';
export * from './registry.js';
export * from './caps.js';
export * from './redactor.js';
