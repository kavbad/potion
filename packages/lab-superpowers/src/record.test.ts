// FIXTURE PROVENANCE STAMPS (Step 11 review addition 3) — a recorded
// fixture carries when it was captured, from where, and what the server
// called itself, so a `fixture-recorded` package has a VISIBLE staleness
// signal as real APIs drift.
//
// No shipped package claims `fixture-recorded` today (at $0 we contacted no
// hosted vendor server; claiming otherwise would be the dishonesty the
// tiering exists to prevent). So the mechanism is proven end-to-end here
// against a REAL recording of the mock server — the machinery is exercised,
// not merely declared, and it is ready for the first genuine capture.
import { afterEach, describe, expect, it } from 'vitest';
import { MockMcpServer } from '@potion/lab-mcp/mock-server';
import { McpSession, StreamableHttpTransport } from '@potion/lab-mcp';
import { CATALOG } from './catalog.js';
import { fixtureAgeDays, validatePackage, type SuperpowerPackage } from './format.js';
import { recordFixture, reconcileWithRecording } from './record.js';
import { honestFixtureTools } from './mini-eval.js';

let server: MockMcpServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const github = CATALOG.find((p) => p.id === 'github')!;

describe('recordFixture — the stamp is real machinery, exercised', () => {
  it('captures a live session\'s tool surface WITH capturedAt, serverVersion and capturedFrom', async () => {
    server = await MockMcpServer.start({ tools: honestFixtureTools(github) });
    const session = await McpSession.open(new StreamableHttpTransport({ baseUrl: server.mcpUrl }));
    const rec = recordFixture(
      {
        serverName: session.serverName,
        serverVersion: '0.0.1',
        endpoint: server.mcpUrl,
        tools: session.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
      new Date('2026-08-14T00:00:00.000Z'),
    );
    expect(rec.stamp.capturedAt).toBe('2026-08-14T00:00:00.000Z');
    expect(rec.stamp.serverVersion).toBe('mock-mcp/0.0.1');
    expect(rec.stamp.capturedFrom).toBe(server.mcpUrl);
    expect(rec.serverTools.map((t) => t.name).sort()).toEqual(github.tools.map((t) => t.name).sort());
    await session.close();
  }, 60_000);

  it('the recording is DATA: the server\'s own descriptions are kept verbatim, never promoted to context', async () => {
    server = await MockMcpServer.start({ tools: honestFixtureTools(github) });
    const session = await McpSession.open(new StreamableHttpTransport({ baseUrl: server.mcpUrl }));
    const rec = recordFixture({
      serverName: session.serverName,
      endpoint: server.mcpUrl,
      tools: session.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
    // the fixture server prefixes '[vendor] ' — the recording keeps it…
    expect(rec.serverTools.every((t) => t.description.startsWith('[vendor] '))).toBe(true);
    // …and the AUTHORED package text is a different string entirely
    expect(github.tools[0]!.description.startsWith('[vendor] ')).toBe(false);
    await session.close();
  }, 60_000);

  it('reconcile surfaces DRIFT: declared tools the server no longer offers', async () => {
    server = await MockMcpServer.start({
      // the "server" dropped one tool since the package was authored
      tools: honestFixtureTools(github).filter((t) => t.name !== 'list_issues'),
    });
    const session = await McpSession.open(new StreamableHttpTransport({ baseUrl: server.mcpUrl }));
    const rec = recordFixture({
      serverName: session.serverName,
      endpoint: server.mcpUrl,
      tools: session.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
    const drift = reconcileWithRecording(github.tools.map((t) => t.name), rec);
    expect(drift.missingFromServer).toEqual(['list_issues']);
    expect(drift.present).not.toContain('list_issues');
    await session.close();
  }, 60_000);

  it('fixtureAgeDays is the staleness signal the catalog surfaces', () => {
    const stamp = { capturedAt: '2026-08-01T00:00:00.000Z', serverVersion: 'x/1', capturedFrom: 'https://x' };
    expect(fixtureAgeDays(stamp, new Date('2026-08-14T00:00:00.000Z'))).toBe(13);
    expect(fixtureAgeDays(stamp, new Date('2026-08-01T06:00:00.000Z'))).toBe(0);
  });
});

describe('the stamp is REQUIRED for the tier it belongs to', () => {
  it('a fixture-recorded package WITHOUT a stamp is a typed validation issue', () => {
    const bad: SuperpowerPackage = { ...github, proof: 'fixture-recorded' };
    const issues = validatePackage(bad);
    expect(issues.map((i) => i.code)).toContain('missing-fixture-stamp');
  });

  it('a fixture-recorded package WITH a stamp validates', () => {
    const good: SuperpowerPackage = {
      ...github,
      proof: 'fixture-recorded',
      fixtureStamp: {
        capturedAt: '2026-08-14T00:00:00.000Z',
        serverVersion: 'github-mcp/2026-08',
        capturedFrom: 'https://api.githubcopilot.com/mcp/',
      },
    };
    expect(validatePackage(good)).toEqual([]);
  });

  it('today NOTHING claims fixture-recorded or live-proven — the honest state, asserted', () => {
    expect(CATALOG.filter((p) => p.proof !== 'fixture-authored')).toEqual([]);
  });
});
