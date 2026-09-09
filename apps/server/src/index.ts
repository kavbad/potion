// Entry point: start the Potion server. PORT env (default 3000). Boot runs
// with zero network/services (PGlite + mock provider + mock embedder
// defaults); see context.ts for the env-key escalation rules.
import { buildServer } from './server.js';
// ---- P1: the clock — armed standing missions run themselves ----
import { startLabScheduler } from './lab-scheduler.js';
// ---- M3 #27 HA (m3-ha) ----
import { installShutdownSignalHandlers } from './shutdown.js';
// ---- end M3 #27 HA imports ----

const port = Number(process.env.PORT ?? 3000);
// A boot gate can now REFUSE (boot-report.ts): a server that cannot be secure
// must not take the port. Caught here so the operator reads the gate and its
// remedy rather than a stack trace, and so the exit code is deliberate.
let app;
try {
  app = await buildServer({
    logger: true,
    log: (msg) => console.log(`[potion] ${msg}`),
  });
} catch (err) {
  const { BootRefusedError } = await import('./boot-report.js');
  if (err instanceof BootRefusedError) {
    for (const g of err.gates) console.error(`[potion] BOOT REFUSED — ${g.name}: ${g.fatal}`);
    process.exit(1);
  }
  throw err;
}
// ---- M3 #27 HA (m3-ha) ----
// SIGTERM/SIGINT → stop accepting, drain in-flight (30s cap), close queue/db,
// exit 0 (force 1 past the cap) — see src/shutdown.ts.
installShutdownSignalHandlers(app, app.potion, { log: (msg) => console.log(`[potion] ${msg}`) });
// ---- end M3 #27 HA ----
// 2026-08-28 one-shot repair: customer keys that got bound to the Lab's
// internal policy rows (lab-io at floor ZERO, dial pins) — the damage the
// serving-policy discipline now prevents — are rebound to the org's real
// policy, minting the default when none exists. Logged per key; a clean
// fleet logs nothing.
{
  const { repairInternalPolicyBindings } = await import('@potion/db');
  const { DEFAULT_ORG_POLICY } = await import('./routing/default-policy.js');
  const repaired = await repairInternalPolicyBindings(app.potion.db.db, DEFAULT_ORG_POLICY);
  for (const r of repaired) {
    console.log(`[potion] policy repair: org ${r.orgId} key ${r.keyId} rebound ${r.from} → ${r.to}`);
  }
  if (repaired.length > 0) console.log(`[potion] policy repair: ${repaired.length} key(s) rebound off internal policies`);
}

// P1 (the clock): armed standing missions start their own checks. Gated by
// POTION_LAB_SCHEDULER ('0' disables); the interval is unref'd so shutdown
// never waits on it.
if (app.potion.queue !== undefined) {
  const started = startLabScheduler({ db: app.potion.db, queue: app.potion.queue, log: (msg) => console.log(`[potion] ${msg}`) });
  if (started !== null) console.log('[potion] lab scheduler ticking (60s)');
}
await app.listen({ port, host: '0.0.0.0' });
