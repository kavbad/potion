// Invoice CLI (M2 Wave 2, ROADMAP #18):
//   pnpm --filter @potion/server invoice -- --org org_demo --period 2026-08 [--margin-pct 10] [--backend json-file] [--out ./invoices]
//
// Flow: db → migrate → idempotent usage rollup for the period (the invoice
// must be current to the cent at generation time; the rollup is a cheap
// full-replace upsert) → generateInvoice → renderInvoiceHtml → backend
// save → print the invoice JSON to stdout and the written paths to stderr.
import { createDb, migrate, aggregateUsage, periodFromDay, periodToDay, isPeriodString } from '@potion/db';
import { ENV_VAR_BY_PROVIDER, loadPrices } from '@potion/providers';
import { DEFAULT_PRICES_PATH } from '../context.js';
import { generateInvoice } from './invoice.js';
import { renderInvoiceHtml } from './render-html.js';
import { resolveBillingBackend } from './backend.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) out[a.slice(2)] = argv[++i]!;
      else out[a.slice(2)] = 'true';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const org = args.org;
  const period = args.period;
  if (!org || !period || !isPeriodString(period)) {
    console.error(
      'usage: invoice --org <orgId> --period <YYYY-MM> [--margin-pct <n>] ' +
        '[--backend json-file|stripe] [--out <dir>]',
    );
    process.exit(1);
  }
  const marginPct = args['margin-pct'] !== undefined ? Number(args['margin-pct']) : undefined;
  if (marginPct !== undefined && (!Number.isFinite(marginPct) || marginPct < 0)) {
    console.error(`invalid --margin-pct '${args['margin-pct']}'`);
    process.exit(1);
  }

  const db = await createDb(process.env.DATABASE_URL);
  try {
    await migrate(db.db);
    const range = { fromDay: periodFromDay(period), toDay: periodToDay(period) };
    const rolled = await aggregateUsage(db.db, range);
    console.error(`usage rollup refreshed (${rolled.length} org/day/cluster rows for ${range.fromDay}..${range.toDay})`);

    // The verified-savings basis (0086) — the context's own rule: live when
    // any provider key is present in the environment.
    const { table: prices } = loadPrices(process.env.POTION_PRICES_PATH ?? DEFAULT_PRICES_PATH);
    const providerMode = Object.values(ENV_VAR_BY_PROVIDER).some((v) => process.env[v] !== undefined)
      ? ('live' as const)
      : ('mock' as const);
    const invoice = await generateInvoice(
      db.db,
      org,
      period,
      { prices, providerMode },
      marginPct !== undefined ? { marginPct } : {},
    );
    const html = renderInvoiceHtml(invoice);
    const backend = resolveBillingBackend(args.backend, args.out);
    const { ref } = await backend.saveInvoice(invoice, html);
    console.error(`invoice written: ${ref} (+ .html)`);
    console.log(JSON.stringify(invoice, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
