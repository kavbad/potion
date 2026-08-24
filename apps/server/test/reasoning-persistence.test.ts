// P1-8 (migration 0052): reasoning marks survive restarts. The mark
// write-throughs onto models.reasoning; boot loads persisted marks back;
// the env seed persists at boot too. clearReasoningMarks() also uninstalls
// the persistence hook, so tests here re-install per case.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { listReasoningAliases, markModelReasoning } from '@potion/db';
import { buildServer } from '../src/server.js';
import {
  clearReasoningMarks,
  isReasoningModel,
  listMarkedReasoning,
  loadReasoningMarks,
  markReasoning,
  setReasoningPersistence,
} from '../src/routing/reasoning.js';

let app: FastifyInstance;

beforeAll(async () => {
  // boot with an env seed so the boot-time persistence path runs for real
  process.env.POTION_REASONING_MODELS = 'haiku-class';
  clearReasoningMarks();
  const { seedReasoningMarks } = await import('../src/routing/reasoning.js');
  seedReasoningMarks();
  app = await buildServer({ seed: false });
});
afterAll(async () => {
  delete process.env.POTION_REASONING_MODELS;
  clearReasoningMarks();
  await app.close();
});
afterEach(() => {
  // keep the env-seeded mark; drop test-added state and hooks
  clearReasoningMarks();
  loadReasoningMarks(['haiku-class']);
});

describe('reasoning marks persist (P1-8)', () => {
  it('boot persisted the env-seeded mark onto the registry', async () => {
    const aliases = await listReasoningAliases(app.potion.db.db);
    expect(aliases).toContain('haiku-class');
  });

  it('a fresh mark writes through exactly once', async () => {
    const persisted: string[] = [];
    setReasoningPersistence((m) => {
      persisted.push(m);
      return Promise.resolve();
    });
    markReasoning('sonnet-class', 'empty_length');
    markReasoning('sonnet-class', 'reasoning_tokens'); // already marked — no second write
    expect(persisted).toEqual(['sonnet-class']);
    expect(isReasoningModel('sonnet-class')).toBe(true);
  });

  it('a registry write round-trips into a cold process via loadReasoningMarks', async () => {
    const db = app.potion.db.db;
    await markModelReasoning(db, 'opus-class');
    const aliases = await listReasoningAliases(db);
    expect(aliases).toContain('opus-class');
    // simulate the next boot
    clearReasoningMarks();
    expect(isReasoningModel('opus-class')).toBe(false);
    loadReasoningMarks(aliases);
    expect(isReasoningModel('opus-class')).toBe(true);
  });

  it('marking an alias the registry does not know is harmless', async () => {
    const db = app.potion.db.db;
    await expect(markModelReasoning(db, 'no-such-model')).resolves.toBeUndefined();
    expect(await listReasoningAliases(db)).not.toContain('no-such-model');
  });

  it('listMarkedReasoning reflects the in-process map', () => {
    expect(listMarkedReasoning()).toContain('haiku-class');
  });
});
