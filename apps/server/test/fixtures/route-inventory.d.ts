/**
 * G2.4 TENANCY LENS (added to the SAME rows, not a fork):
 *   'org-param'   — the route names an org-owned resource by param; another
 *                   org's real id must be indistinguishable from a nonexistent
 *                   one (the uniform no-existence-oracle 404).
 *   'org-list'    — returns a collection scoped to the caller's org; another
 *                   org's rows must never appear.
 *   'self-scoped' — acts only on the CALLER's own credential/session.
 *   'shared-global' — platform assets by design (taxonomy frontiers, price
 *                   table, recipe library, leaderboard).
 *   'platform-job'— a job with no owning org (the sweeps): invisible to
 *                   tenants, operator-only.
 *   'public' | 'operator' | 'non-tenant' — no tenant dimension.
 */
export type TenancyClass = 'org-param' | 'org-list' | 'self-scoped' | 'shared-global' | 'platform-job' | 'public' | 'operator' | 'non-tenant';
export interface CrossOrgProbe {
    /** 'uniform-404': org B hitting org A's real id is byte-indistinguishable
     *  from a nonexistent id. 'org-list-absent': org A's rows never appear in
     *  org B's response. 'skip': cannot leak — skipReason REQUIRED. */
    expect: 'uniform-404' | 'org-list-absent' | 'skip';
    skipReason?: string;
}
export interface RouteInventoryRow {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    /** fastify-registered form, e.g. '/api/incidents/:id/resolve'. */
    path: string;
    surface: 'api' | 'v1' | 'auth' | 'operator' | 'infra';
    mutating: boolean;
    guard: 'admin' | 'member' | 'viewer' | 'serve' | 'operator' | 'public';
    /** Concrete URL for probing (params filled with syntactically-valid ids). */
    probeUrl?: string;
    probeBody?: Record<string, unknown>;
    notes?: string;
    tenancyClass?: TenancyClass;
    /** The path param naming the org-owned resource (org-param rows). */
    resourceParam?: string;
    /** What the sweep must seed in ORG_A so the probe uses a REAL foreign id. */
    seededResource?: 'providerKey' | 'apiKey' | 'job' | 'cluster' | 'trace' | 'incident' | 'rubric' | 'shareToken' | 'alertRule' | 'none';
    crossOrgProbe?: CrossOrgProbe;
}
export declare const ROUTE_INVENTORY: RouteInventoryRow[];
