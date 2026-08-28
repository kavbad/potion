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
const app = await buildServer({
  logger: true,
  log: (msg) => console.log(`[potion] ${msg}`),
});
// ---- M3 #27 HA (m3-ha) ----
// SIGTERM/SIGINT → stop accepting, drain in-flight (30s cap), close queue/db,
// exit 0 (force 1 past the cap) — see src/shutdown.ts.
installShutdownSignalHandlers(app, app.potion, { log: (msg) => console.log(`[potion] ${msg}`) });
// ---- end M3 #27 HA ----
// P1 (the clock): armed standing missions start their own checks. Gated by
// POTION_LAB_SCHEDULER ('0' disables); the interval is unref'd so shutdown
// never waits on it.
if (app.potion.queue !== undefined) {
  const started = startLabScheduler({ db: app.potion.db, queue: app.potion.queue, log: (msg) => console.log(`[potion] ${msg}`) });
  if (started !== null) console.log('[potion] lab scheduler ticking (60s)');
}
await app.listen({ port, host: '0.0.0.0' });
