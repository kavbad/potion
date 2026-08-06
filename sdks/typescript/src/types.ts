/** Types for @potion/sdk (SPEC §13.2). */

/**
 * Parsed `x-frontier-trace` response header.
 *
 * The server emits a semicolon-separated header, e.g.:
 *
 * ```
 * cluster=code-gen;strategy=1a2b3c4d;frontier=v3;policy=min_cost;fallback=0;provenance=live
 * ```
 *
 * (plus `policy_override=<name>` when an X-Potion-Policy override was
 * active, and `upgraded=0|1` for composite strategies). Access fields via
 * {@link FrontierTrace.get} or the typed getters. Unknown/absent fields
 * return `undefined` from the getters.
 */
export class FrontierTrace {
  /** All parsed key/value pairs, verbatim from the wire. */
  readonly entries: Readonly<Record<string, string>>;

  private constructor(entries: Record<string, string>) {
    this.entries = entries;
  }

  /** Parse the raw header value; `null`/`undefined`/empty in → `null` out. */
  static parse(header: string | null | undefined): FrontierTrace | null {
    if (!header) return null;
    const out: Record<string, string> = {};
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return new FrontierTrace(out);
  }

  /** Raw field access by wire name (e.g. `trace.get('policy_override')`). */
  get(key: string): string | undefined {
    return this.entries[key];
  }

  get cluster(): string | undefined {
    return this.entries['cluster'];
  }

  get strategy(): string | undefined {
    return this.entries['strategy'];
  }

  get frontier(): string | undefined {
    return this.entries['frontier'];
  }

  /** The ACTIVE policy type (the override's type when overridden). */
  get policy(): string | undefined {
    return this.entries['policy'];
  }

  /** Name of the X-Potion-Policy override row, when one was active. */
  get policyOverride(): string | undefined {
    return this.entries['policy_override'];
  }

  get fallback(): string | undefined {
    return this.entries['fallback'];
  }

  get provenance(): string | undefined {
    return this.entries['provenance'];
  }

  get upgraded(): string | undefined {
    return this.entries['upgraded'];
  }

  toJSON(): Record<string, string> {
    return { ...this.entries };
  }
}
