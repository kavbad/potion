// BYO-MCP — the org-registered endpoint rows. Caps enforced here: at most
// 20 custom connectors per org, at most 40 pinned tools each; the pinned
// text budgets are enforced upstream at probe time (this repo stores what
// the route already bounded, and re-checks the shape cheaply).
import { and, eq } from 'drizzle-orm';
import type { PotionDb } from '../db.js';
import { labCustomConnectors } from '../schema.js';

export const CUSTOM_CONNECTOR_LIMITS = {
  MAX_PER_ORG: 20,
  MAX_TOOLS: 40,
} as const;

export interface CustomConnectorRow {
  orgId: string;
  connectorId: string;
  displayName: string;
  endpointUrl: string;
  serverName: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  createdBy: string;
  createdAt: Date;
}

export async function listLabCustomConnectors(db: PotionDb, orgId: string): Promise<CustomConnectorRow[]> {
  const rows = await db.select().from(labCustomConnectors).where(eq(labCustomConnectors.orgId, orgId));
  return rows as CustomConnectorRow[];
}

export async function getLabCustomConnector(
  db: PotionDb,
  orgId: string,
  connectorId: string,
): Promise<CustomConnectorRow | null> {
  const rows = await db
    .select()
    .from(labCustomConnectors)
    .where(and(eq(labCustomConnectors.orgId, orgId), eq(labCustomConnectors.connectorId, connectorId)))
    .limit(1);
  return (rows[0] as CustomConnectorRow | undefined) ?? null;
}

export type UpsertCustomConnectorResult = { ok: true } | { ok: false; reason: string };

export async function upsertLabCustomConnector(
  db: PotionDb,
  row: Omit<CustomConnectorRow, 'createdAt'>,
): Promise<UpsertCustomConnectorResult> {
  if (row.tools.length === 0) return { ok: false, reason: 'the server declared no tools — nothing to register' };
  if (row.tools.length > CUSTOM_CONNECTOR_LIMITS.MAX_TOOLS) {
    return { ok: false, reason: `the server declares ${row.tools.length} tools — the cap is ${CUSTOM_CONNECTOR_LIMITS.MAX_TOOLS}` };
  }
  const existing = await listLabCustomConnectors(db, row.orgId);
  if (!existing.some((c) => c.connectorId === row.connectorId) && existing.length >= CUSTOM_CONNECTOR_LIMITS.MAX_PER_ORG) {
    return { ok: false, reason: `this org already has ${existing.length} custom connectors — the cap is ${CUSTOM_CONNECTOR_LIMITS.MAX_PER_ORG}` };
  }
  await db
    .insert(labCustomConnectors)
    .values({ ...row })
    .onConflictDoUpdate({
      target: [labCustomConnectors.orgId, labCustomConnectors.connectorId],
      set: {
        displayName: row.displayName,
        endpointUrl: row.endpointUrl,
        serverName: row.serverName,
        tools: row.tools,
        createdBy: row.createdBy,
      },
    });
  return { ok: true };
}

export async function deleteLabCustomConnector(db: PotionDb, orgId: string, connectorId: string): Promise<void> {
  await db
    .delete(labCustomConnectors)
    .where(and(eq(labCustomConnectors.orgId, orgId), eq(labCustomConnectors.connectorId, connectorId)));
}
