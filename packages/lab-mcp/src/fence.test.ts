// The hosted-only fence (Step 10 §2): user-supplied server PROCESSES are
// structurally impossible, not merely disallowed. The client surface has
// no stdio transport member, spawns nothing, and listens on nothing —
// asserted over the SOURCE, so a future transport cannot sneak one in.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

// mock-server.ts is the ONE deliberate listener: it PLAYS the remote hosted
// server so the client can be proven against a real wire. It is exported
// only through the './mock-server' subpath, never the main index, and no
// client module imports it — asserted below, so the exemption cannot rot
// into a loophole.
const EXEMPT = new Set(['mock-server.ts']);

/** The fence judges CODE, not prose — comments legitimately name the very
 * things they forbid (this file included). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/(?<=\s)\/\/[^\n]*$/gm, '');

const clientSources = (): Array<{ name: string; src: string }> =>
  readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !EXEMPT.has(f))
    .map((name) => ({ name, src: stripComments(readFileSync(`${SRC_DIR}/${name}`, 'utf8')) }));

describe('hosted-only fence', () => {
  it('no client module references child_process, spawn/exec, node:net, or createServer', () => {
    for (const { name, src } of clientSources()) {
      expect(src, `${name} must not touch child_process`).not.toMatch(/child_process/);
      expect(src, `${name} must not spawn processes`).not.toMatch(/\b(?:spawn|execFile|exec|fork)\s*\(/);
      expect(src, `${name} must not import node:net`).not.toMatch(/['"]node:net['"]/);
      expect(src, `${name} must not create a server`).not.toMatch(/createServer/);
    }
  });

  it('the transport union has NO stdio member', () => {
    for (const { name, src } of clientSources()) {
      expect(src, `${name} must not mention a stdio transport`).not.toMatch(/['"]stdio['"]/);
    }
    const registry = readFileSync(`${SRC_DIR}/registry.ts`, 'utf8');
    expect(registry).toMatch(/transport: 'streamable-http'/);
  });

  it('no client module imports the mock server (the exemption is one-way)', () => {
    for (const { name, src } of clientSources()) {
      expect(src, `${name} must not import mock-server`).not.toMatch(/mock-server/);
    }
    const index = stripComments(readFileSync(`${SRC_DIR}/index.ts`, 'utf8'));
    expect(index).not.toMatch(/mock-server/);
  });

  it('the attribution rule carries its provisional re-derivation note (the WORTH_TO_FUEL convention)', () => {
    const caps = readFileSync(`${SRC_DIR}/caps.ts`, 'utf8');
    expect(caps).toMatch(/PROVISIONAL/);
    expect(caps).toMatch(/re-derive attribution from observed step composition and RETIRE/);
  });
});
