// org:delete handler (G2.7) — the TRUE-CASCADE carve-out's job wrapper.
// The cascade itself lives in @potion/db deleteOrgCascade (the only code
// path allowed to hard-delete evidence). The factory takes an onOrgDeleted
// hook so the in-process server can invalidate its per-org caches (provider
// sets, budget MTD, api-key auth) — a revoked key must not keep serving for
// a cache TTL after its org is gone.
import { deleteOrgCascade, type OrgDeleteReport } from '@potion/db';
import type { JobContext, WorkerHandler } from './handlers.js';
import type { OrgDeletePayload } from './jobs.js';

export interface OrgDeleteHandlerOpts {
  /** Called after a successful (non-no-op) cascade — cache invalidation. */
  onOrgDeleted?: (orgId: string) => void | Promise<void>;
}

export function createOrgDeleteHandler(
  opts: OrgDeleteHandlerOpts = {},
): WorkerHandler<'org:delete', OrgDeleteReport> {
  return async (payload: OrgDeletePayload, ctx: JobContext): Promise<OrgDeleteReport> => {
    // deleteOrgCascade refuses DEFAULT_ORG_ID and is idempotent; the report
    // (per-table counts) is the job result — status + evidence, always.
    const report = await deleteOrgCascade(ctx.db, payload.orgId);
    if (!report.alreadyDeleted && opts.onOrgDeleted) {
      await opts.onOrgDeleted(payload.orgId);
    }
    return report;
  };
}

export const orgDeleteHandler = createOrgDeleteHandler();
