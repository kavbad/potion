// FIXTURE RECORDING with a provenance stamp (Step 11 review addition 3).
//
// A `fixture-recorded` package's tool surface was captured from a REAL
// server at a REAL moment. Real APIs drift, so the capture carries its own
// staleness signal: when it was taken, from which endpoint, and what the
// server called itself. The catalog surfaces the age; a stale recording is
// visible rather than quietly wrong.
//
// The recorder is deliberately transport-agnostic — it takes an already-open
// session's reported serverInfo + tools. Today no shipped package claims
// `fixture-recorded` (at $0 we contacted no hosted vendor server, and
// claiming otherwise would be the exact dishonesty the tiering exists to
// prevent), so the mechanism is exercised end-to-end against the mock
// server in record.test.ts: the machinery is real and proven, and it is
// ready for the first genuine capture.
import type { FixtureStamp } from './format.js';

export interface RecordedFixture {
  stamp: FixtureStamp;
  /** The server's tool surface exactly as reported, VERBATIM. Recorded as
   * DATA for diffing against the authored package — never fed to a model
   * (the authored strings are the only ones that reach context). */
  serverTools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface RecordSource {
  /** serverInfo as reported at initialize. */
  serverName: string;
  serverVersion?: string | undefined;
  endpoint: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

/** Build the stamped recording. `now` is injected so a capture is
 * reproducible in tests (the Step 9 clock discipline). */
export function recordFixture(src: RecordSource, now: Date = new Date()): RecordedFixture {
  return {
    stamp: {
      capturedAt: now.toISOString(),
      serverVersion: `${src.serverName}/${src.serverVersion ?? 'unknown'}`,
      capturedFrom: src.endpoint,
    },
    serverTools: [...src.tools]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
}

/**
 * What a recording tells us about an authored package: which declared tools
 * the real server actually offers, and which it does not. A drifted
 * recording (declared tools the server no longer has) is the signal the
 * staleness stamp exists to make visible.
 */
export function reconcileWithRecording(
  declaredToolNames: readonly string[],
  rec: RecordedFixture,
): { present: string[]; missingFromServer: string[]; extraOnServer: string[] } {
  const offered = new Set(rec.serverTools.map((t) => t.name));
  const declared = new Set(declaredToolNames);
  return {
    present: declaredToolNames.filter((n) => offered.has(n)).sort(),
    missingFromServer: declaredToolNames.filter((n) => !offered.has(n)).sort(),
    extraOnServer: rec.serverTools.map((t) => t.name).filter((n) => !declared.has(n)).sort(),
  };
}
