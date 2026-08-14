// Connector OAuth flow state (Step 10) — the oidc.ts machinery applied to
// third-party superpower grants: authorization-code + PKCE S256, with an
// ORG-BOUND signed state cookie as the tenancy anchor. The cookie is
// integrity-protected (HMAC keyed off the connector's client secret — no
// extra env secret) and carries no secret worth hiding: the verifier is
// useless without the code, the code useless without the verifier, and the
// callback additionally requires the LIVE admin session of the SAME org
// the flow was started for.
//
// The access token itself never touches this module: the callback route
// exchanges the code in its own stack frame, seals with @potion/custody,
// and stores the envelope — never logged, never in a redirect URL, never
// in a response body.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CONNECTOR_STATE_COOKIE = 'potion_connector_oauth';
export const CONNECTOR_STATE_TTL_MS = 10 * 60 * 1000;

export class ConnectorOauthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ConnectorOauthError';
  }
}

export interface ConnectorFlowState {
  state: string;
  /** PKCE S256 verifier — goes ONLY to the token endpoint. */
  verifier: string;
  /** The org the flow was STARTED for — the callback refuses any session
   * whose org differs (the tenancy anchor). */
  orgId: string;
  connectorId: string;
  expiresAt: number;
}

export function newConnectorFlowState(orgId: string, connectorId: string): ConnectorFlowState {
  return {
    state: randomBytes(16).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
    orgId,
    connectorId,
    expiresAt: Date.now() + CONNECTOR_STATE_TTL_MS,
  };
}

export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function hmacKey(clientSecret: string): Buffer {
  return createHash('sha256').update(`potion-connector-state:${clientSecret}`, 'utf8').digest();
}

function sign(value: string, clientSecret: string): string {
  return createHmac('sha256', hmacKey(clientSecret)).update(value, 'utf8').digest('base64url');
}

export function encodeConnectorState(flow: ConnectorFlowState, clientSecret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, clientSecret)}`;
}

export function decodeConnectorState(
  raw: string | undefined,
  clientSecret: string,
): ConnectorFlowState {
  if (!raw) throw new ConnectorOauthError('missing connector flow cookie — restart the connect', 400);
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) throw new ConnectorOauthError('malformed connector flow cookie', 400);
  const payload = raw.slice(0, dot);
  const expected = sign(payload, clientSecret);
  const got = raw.slice(dot + 1);
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ConnectorOauthError('connector flow cookie signature mismatch', 400);
  }
  let flow: ConnectorFlowState;
  try {
    flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConnectorFlowState;
  } catch {
    throw new ConnectorOauthError('malformed connector flow cookie', 400);
  }
  if (typeof flow.expiresAt !== 'number' || flow.expiresAt <= Date.now()) {
    throw new ConnectorOauthError('connector flow expired — restart the connect', 400);
  }
  return flow;
}
