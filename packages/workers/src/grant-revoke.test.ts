// lab:grant-revoke — best-effort provider-side revocation. The /revoke route
// already marked the grant 'revoked' (local truth); this job kills the token
// upstream. Every outcome is a RECORDED result, never a retry storm, never an
// un-revoke.
import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createDb,
  markLabGrantStatus,
  seedIsolationOrgs,
  upsertLabGrant,
  ORG_A,
  type DbHandle,
} from '@potion/db';
import { sealEnvelope, StaticMasterKeyProvider } from '@potion/custody';
import type { ConnectorDef } from '@potion/lab-mcp';
import { createLabGrantRevokeHandler, DEFAULT_PRICES_PATH } from './handlers.js';
import type { JobContext } from './index.js';

const MASTER = randomBytes(32).toString('hex');
const TOKEN = 'gho_revokeTEST4X9mQ2vL7pK8rT3sW6zE1yNb6';

function connector(revocationUrl: string | undefined): ConnectorDef {
  return {
    connectorId: 'github',
    displayName: 'GitHub',
    transport: 'streamable-http',
    baseUrl: 'https://unused.example',
    oauth: {
      authorizationUrl: 'https://unused/a',
      tokenUrl: 'https://unused/t',
      clientIdEnv: 'REVOKE_CLIENT_ID',
      clientSecretEnv: 'REVOKE_CLIENT_SECRET',
      scopesOffered: [],
    },
    tools: {
      get_me: {
        scopes: [],
        action: 'read',
        description: 'Return the authenticated user.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    ...(revocationUrl !== undefined ? { revocationUrl } : {}),
  };
}

let handle: DbHandle | null = null;
const envBefore = { id: process.env.REVOKE_CLIENT_ID, secret: process.env.REVOKE_CLIENT_SECRET };
afterEach(async () => {
  await handle?.close();
  handle = null;
  process.env.REVOKE_CLIENT_ID = envBefore.id;
  process.env.REVOKE_CLIENT_SECRET = envBefore.secret;
});

async function seeded(): Promise<DbHandle> {
  const h = await createDb();
  const { migrate } = await import('@potion/db');
  await migrate(h.db);
  await seedIsolationOrgs(h.db);
  await upsertLabGrant(h.db, {
    id: 'grant-rev',
    orgId: ORG_A,
    connectorId: 'github',
    superpowerId: 'github',
    scopesGranted: [],
    tokenEnvelope: sealEnvelope(Buffer.from(MASTER, 'hex'), TOKEN),
    grantedBy: 'usr_admin',
  });
  await markLabGrantStatus(h.db, ORG_A, 'github', 'revoked'); // the route did this first
  return h;
}

const ctxFor = (h: DbHandle): JobContext => ({ db: h.db, dbHandle: h, pricesPath: DEFAULT_PRICES_PATH });

describe('lab:grant-revoke', () => {
  it('calls the provider DELETE with the sealed token and reports revoked', async () => {
    handle = await seeded();
    process.env.REVOKE_CLIENT_ID = 'Iv1.rev';
    process.env.REVOKE_CLIENT_SECRET = 'rev-secret';
    let seen: { url: string; body: string } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), body: String(init?.body ?? '') };
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const handler = createLabGrantRevokeHandler({
      masterKeyProvider: new StaticMasterKeyProvider(MASTER),
      connectors: [connector('https://api.github.com/applications/{clientId}/grant')],
      fetchImpl,
    });
    const result = await handler({ orgId: ORG_A, connectorId: 'github' }, ctxFor(handle));
    expect(result.provider).toBe('revoked');
    expect(seen!.url).toContain('Iv1.rev'); // {clientId} substituted
    expect(seen!.body).toContain(TOKEN); // the sealed token, opened for the provider call ONLY
  });

  it('skips gracefully when the connector has no revocation endpoint', async () => {
    handle = await seeded();
    const handler = createLabGrantRevokeHandler({
      masterKeyProvider: new StaticMasterKeyProvider(MASTER),
      connectors: [connector(undefined)],
    });
    const result = await handler({ orgId: ORG_A, connectorId: 'github' }, ctxFor(handle));
    expect(result.provider).toBe('skipped');
  });

  it('skips when client credentials are not configured', async () => {
    handle = await seeded();
    delete process.env.REVOKE_CLIENT_ID;
    delete process.env.REVOKE_CLIENT_SECRET;
    const handler = createLabGrantRevokeHandler({
      masterKeyProvider: new StaticMasterKeyProvider(MASTER),
      connectors: [connector('https://api.github.com/applications/{clientId}/grant')],
    });
    const result = await handler({ orgId: ORG_A, connectorId: 'github' }, ctxFor(handle));
    expect(result.provider).toBe('skipped');
  });

  it('a provider outage is a recorded failure, never a throw', async () => {
    handle = await seeded();
    process.env.REVOKE_CLIENT_ID = 'Iv1.rev';
    process.env.REVOKE_CLIENT_SECRET = 'rev-secret';
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const handler = createLabGrantRevokeHandler({
      masterKeyProvider: new StaticMasterKeyProvider(MASTER),
      connectors: [connector('https://api.github.com/applications/{clientId}/grant')],
      fetchImpl,
    });
    const result = await handler({ orgId: ORG_A, connectorId: 'github' }, ctxFor(handle));
    expect(result.provider).toBe('failed');
    expect(result.detail).toContain('connection refused');
  });
});
