// G2.4 mock-eligibility regressions (the false-live class): sites where a
// MOCK alias could be selected, executed or recorded while the surrounding
// mode was 'live'. Each test FAILED before its fix.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, listResearchCycles, migrate, type DbHandle } from '@potion/db';
import { diffModelListings, mockModels, loadPrices } from '@potion/providers';
import { buildRegistry, classRepresentative } from '@potion/researcher';
import { researchCycleHandler, type JobContext } from './handlers.js';

const REPO_PRICES = fileURLToPath(new URL('../../../prices.json', import.meta.url));

let root: string;
let pricesPath: string;
let db: DbHandle;

function ctx(): JobContext {
  return { db: db.db, dbHandle: db, pricesPath };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'potion-falselive-'));
  pricesPath = path.join(root, 'prices.json');
  copyFileSync(REPO_PRICES, pricesPath);
  db = await createDb();
  await migrate(db.db);
  delete process.env.POTION_RESEARCH_PROVIDER;
});

afterEach(async () => {
  delete process.env.POTION_RESEARCH_PROVIDER;
  await db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('scan: mock-origin listings keep the mock provider id', () => {
  // Pre-fix: diffModelListings stamped EVERY new listing 'openrouter',
  // including the mock/* fixtures the mock scan source emits — which made
  // them invisible to every provider === 'mock' guard and therefore
  // eligible as LIVE class representatives.
  it('mock/* listings classify as provider mock and drop out of a live registry', () => {
    const prices = loadPrices(pricesPath).table;
    const diff = diffModelListings(mockModels(), prices);
    expect(diff.added.length).toBeGreaterThan(0);
    for (const entry of diff.added) {
      expect(entry.model.startsWith('mock/')).toBe(true);
      expect(entry.provider, `${entry.alias} must not masquerade as a real provider`).toBe('mock');
    }
    // …and a live-style registry filter now excludes them.
    const merged = { ...prices, entries: [...prices.entries, ...diff.added] };
    const liveRegistry = buildRegistry(merged).filter((e) => e.provider !== 'mock');
    for (const entry of diff.added) {
      expect(liveRegistry.some((r) => r.alias === entry.alias)).toBe(false);
    }
    // The class representative of a live registry is never a mock alias.
    for (const cls of ['cheap', 'mid', 'strong', 'judge'] as const) {
      const rep = classRepresentative(liveRegistry, cls);
      if (rep) expect(rep.provider).not.toBe('mock');
    }
  });
});

describe('live research cycle: refuses keyless, and always settles its ledger row', () => {
  // Pre-fix: a live cycle generated candidates over the UNFILTERED registry
  // (mock aliases are $0, so they won every class), then died inside
  // runEval on MockAliasInLiveRunError — leaving research_cycles at
  // 'running' forever.
  it('a keyless live cycle refuses and marks the cycle failed, never stuck running', async () => {
    process.env.POTION_RESEARCH_PROVIDER = 'live';
    await expect(researchCycleHandler({ trigger: 'manual' }, ctx())).rejects.toThrow(
      /live research cycle refused|no provider API keys|resolve to the mock provider/,
    );
    const cycles = await listResearchCycles(db.db, 10);
    // Either the refusal happened before the ledger row (nothing recorded)
    // or the row exists and is SETTLED — never left 'running'.
    for (const c of cycles) {
      expect(c.status, `cycle ${c.id} left unsettled`).not.toBe('running');
    }
  });

  // A real mock sweep runs inside this one — the default 5s timeout is tight
  // under parallel suite load (research.test.ts uses the same headroom).
  it('a mock cycle still completes normally (the guard is live-only)', { timeout: 60_000 }, async () => {
    const res = (await researchCycleHandler({ trigger: 'manual' }, ctx())) as {
      cycleId: string;
    };
    expect(res.cycleId).toBeTruthy();
    const cycles = await listResearchCycles(db.db, 10);
    expect(cycles.every((c) => c.status !== 'running')).toBe(true);
  });
});
