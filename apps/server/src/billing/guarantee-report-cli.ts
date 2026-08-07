// Monthly guarantee-report artifact CLI (G2.1) — the invoice CLI's sibling:
//   pnpm --filter @potion/server guarantee-report -- --org org-acme --period 2026-08 [--backend json-file] [--out ./invoices]
//
// Renders the SAME report the authed /api/reports/guarantee route serves
// for the period window and saves <org>-<period>-guarantee.json/.html next
// to the invoice via the billing backend. An org with no guarantee
// evidence produces an empty report, not an error.
import { createDb, migrate, isPeriodString, periodFromDay, periodToDay } from '@potion/db';
import { loadGuaranteeReport } from '../routes/guarantee-report.js';
import { renderGuaranteeReportHtml } from './render-guarantee-html.js';
import { resolveBillingBackend } from './backend.js';
import type { PotionContext } from '../context.js';

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
      'usage: guarantee-report --org <orgId> --period <YYYY-MM> [--backend json-file|stripe] [--out <dir>]',
    );
    process.exit(1);
  }
  const db = await createDb(process.env.DATABASE_URL);
  try {
    await migrate(db.db);
    // loadGuaranteeReport only touches ctx.db — a minimal context suffices.
    const ctx = { db } as PotionContext;
    const report = await loadGuaranteeReport(ctx, org, {
      fromDay: periodFromDay(period),
      toDay: periodToDay(period),
    });
    const html = renderGuaranteeReportHtml(report);
    const backend = resolveBillingBackend(args.backend, args.out);
    const { ref } = await backend.saveReport(`${org}-${period}-guarantee`, report, html);
    console.error(`guarantee report written: ${ref} (+ .html)`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
