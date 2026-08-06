// Entry point: start the Potion server. PORT env (default 3000). Boot runs
// with zero network/services (PGlite + mock provider + mock embedder
// defaults); see context.ts for the env-key escalation rules.
import { buildServer } from './server.js';
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
await app.listen({ port, host: '0.0.0.0' });
