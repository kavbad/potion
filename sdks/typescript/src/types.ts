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

  /**
   * Present only when the policy floor excluded points on EVIDENCE WIDTH
   * rather than measured quality: the count of models that scored at or
   * above the bar but whose confidence interval dips below it. Not a
   * verdict on the model — the evidence is too thin to prove the number.
   */
  get underpowered(): string | undefined {
    return this.entries['underpowered'];
  }

  get upgraded(): string | undefined {
    return this.entries['upgraded'];
  }

  toJSON(): Record<string, string> {
    return { ...this.entries };
  }
}

/**
 * The typed routing object every non-streaming answer carries at the top
 * level as `potion` (the `x-frontier-trace` header stays the source record).
 * Field names are the wire's, verbatim.
 */
export interface PotionRouting {
  /** The cluster the request asked for via `x-potion-cluster`, or `'auto'`. */
  requested_cluster: string;
  /** The cluster the request was actually served under. */
  resolved_cluster: string;
  /** The `x-potion-policy` override name, or `null`. */
  requested_policy: string | null;
  policy_source: 'override' | 'key_default';
  resolved_policy_type: string;
  /** The model that answered. */
  model: string;
  /** `true` when NO measured point satisfied the policy and a fallback served — the receipt's "not routed". */
  fallback: boolean;
  /** Why, when `fallback` is true: `policy_infeasible`, `reasoning_budget`, `no_frontier`, `no_point_resolvable`. */
  fallback_reason?: string;
  /** Metered charge for this request in USD, when the server reports one. */
  cost_usd?: number;
  /** `tools` | `vision` | `audio` when a non-default instrument's frontier served. */
  instrument?: string;
  /** `empty_answer` | `provider_error` when a second attempt answered. */
  retry?: string;
  provenance: string;
}
