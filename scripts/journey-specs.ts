// Journey-grain equivalence corpus (2026-08-25, operator-approved item 2).
//
// Nine multi-step journeys, three families. Each step's output feeds the
// next step's prompt; the FINAL artifact is scored deterministically
// (field-match / exact / code-exec) — no judge anywhere, so the equivalence
// claim rests on machine-checkable ends. Steps are labeled with the cluster
// their work belongs to; the heterogeneous arm routes each step to the
// serving frontier's pick for that cluster, the monolith arm answers every
// step with one strong model. Honest scope: synthetic journeys authored to
// mirror common pipelines; partner traffic adjudicates the bet for real.

export interface JourneyStep {
  /** The kind of work — decides the heterogeneous arm's model. */
  clusterId: string;
  /** Prompt template; {{prev}} is replaced with the previous step's output. */
  prompt: string;
}

export type JourneyCheck =
  | { kind: 'field-match'; fields: Record<string, string | string[]> }
  | { kind: 'code-exec'; tests: string };

export interface Journey {
  id: string;
  steps: JourneyStep[];
  /** Deterministic check applied to the FINAL step's output. */
  check: JourneyCheck;
}

const TICKET_A = `From: dana@northwind.example
Subject: order 88231 — wrong item AGAIN

This is the second time. I ordered the ceramic pour-over set (SKU KV-210)
and received a metal french press. I need the right item before Sept 3 or a
refund. My order number is 88231. Honestly considering cancelling my
subscription over this.`;

const TICKET_B = `From: procurement@atlas-mfg.example
Subject: invoice question

Hi — invoice INV-5502 lists a "platform fee" of $140 we do not recognize.
Our PO 7741 covered $2,300 for the sensor kits only. Please reissue the
invoice without the fee or explain it. Not urgent, we pay net-30.`;

const TICKET_C = `From: sam@quickbite.example
Subject: URGENT app down

Your dashboard returns 500s since 9am for our whole team (12 seats, account
QB-3319). We are in the middle of a launch. Phone support said to email.
If this is not fixed today we need to escalate to your CTO.`;

export const JOURNEYS: Journey[] = [
  // ---- family 1: support-ticket pipeline (extract → classify → reply → report)
  ...([
    ['jt-a', TICKET_A, { order_ref: '88231', wants_by: ['Sept 3', 'September 3'], sku: 'KV-210' }, 'standard'],
    ['jt-b', TICKET_B, { order_ref: ['INV-5502', '5502'], disputed_amount: ['140', '$140'], po: ['7741', 'PO 7741'] }, 'low'],
    ['jt-c', TICKET_C, { account: 'QB-3319', seats: '12', since: ['9am', '9 am'] }, 'urgent'],
  ] as Array<[string, string, Record<string, string | string[]>, string]>).map(([id, ticket, fields, priority]) => ({
    id,
    steps: [
      {
        clusterId: 'extraction',
        prompt: `Extract from this support email as JSON with keys ${Object.keys(fields).map((k) => `"${k}"`).join(', ')} (values verbatim from the text):\n\n${ticket}\n\nRespond with ONLY the JSON object.`,
      },
      {
        clusterId: 'classification',
        prompt: `A support ticket produced this extract:\n{{prev}}\n\nRule: answer "urgent" ONLY if the customer states an active outage or a same-day deadline for their business; "standard" if a delivery/replacement deadline is named but days away; "low" if the customer explicitly says it is not urgent. The only permitted answers are: urgent, standard, low. Answer with the label only.`,
      },
      {
        clusterId: 'rewrite-edit',
        prompt: `Write a 3-sentence support reply for a ticket with priority {{prev}} and this extract:\n{{prev1}}\n\nThe reply must reference the customer's order/invoice reference verbatim. Respond with only the reply text.`,
      },
      {
        clusterId: 'extraction',
        prompt: `Produce the final case report as JSON with keys "extract" (the JSON object below, unchanged), "priority" (the label below, unchanged), "reply" (the reply below, unchanged).\n\nextract: {{prev2}}\npriority: {{prev1}}\nreply: {{prev}}\n\nRespond with ONLY the JSON object.`,
      },
    ],
    check: { kind: 'field-match', fields: { ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`extract.${k}`, v])), priority } } as JourneyCheck,
  })),

  // ---- family 2: code pipeline (spec-tighten → implement → harden)
  ...([
    [
      'jc-a',
      'a function slugify(s) that lowercases, replaces every run of non-alphanumeric characters with a single hyphen, and strips leading/trailing hyphens',
      `test("basic", () => assert(slugify("Hello World") === "hello-world"));
test("runs collapse", () => assert(slugify("a --_ b") === "a-b"));
test("trim", () => assert(slugify("--x--") === "x"));
test("digits kept", () => assert(slugify("v2.0 beta") === "v2-0-beta"));
test("empty", () => assert(slugify("!!!") === ""));`,
    ],
    [
      'jc-b',
      'a function median(xs) returning the median of a non-empty numeric array without mutating the input (average the two middle values for even length)',
      `test("odd", () => assert(median([3,1,2]) === 2));
test("even", () => assert(median([4,1,3,2]) === 2.5));
test("no mutation", () => { const a=[9,1]; median(a); assert(a[0] === 9 && a[1] === 1); });
test("single", () => assert(median([7]) === 7));
test("negatives", () => assert(median([-3,-1,-2]) === -2));`,
    ],
    [
      'jc-c',
      'a function dedupeBy(xs, key) keeping the FIRST occurrence per key(x) value, preserving order',
      `test("keeps first", () => assertDeepEqual(dedupeBy([{id:1,v:"a"},{id:1,v:"b"},{id:2,v:"c"}], x => x.id).map(x=>x.v), ["a","c"]));
test("order", () => assertDeepEqual(dedupeBy([3,1,3,2,1], x => x), [3,1,2]));
test("empty", () => assertDeepEqual(dedupeBy([], x => x), []));
test("all same", () => assertDeepEqual(dedupeBy(["x","x"], x => x), ["x"]));`,
    ],
  ] as Array<[string, string, string]>).map(([id, spec, tests]) => ({
    id,
    steps: [
      {
        clusterId: 'summarization',
        prompt: `Restate this informal spec as 3-5 numbered, precise requirements (inputs, outputs, edge cases). Requirement 1 MUST state the exact function name and parameter list verbatim from the spec. Spec: ${spec}\n\nRespond with only the numbered list.`,
      },
      {
        clusterId: 'code-gen',
        prompt: `Implement exactly this specification in JavaScript, using EXACTLY the function name and parameters stated in requirement 1:\n{{prev}}\n\nRespond with ONLY the function source (a function declaration, not an arrow assignment), no markdown fences, no explanation.`,
      },
      {
        clusterId: 'code-review',
        prompt: `Review this implementation against the numbered spec. If it is fully correct, return it UNCHANGED. If not, return the corrected function. Spec:\n{{prev1}}\n\nImplementation:\n{{prev}}\n\nRespond with ONLY the final function source, no markdown fences, no explanation.`,
      },
    ],
    check: { kind: 'code-exec', tests } as JourneyCheck,
  })),

];

// Family 3 authored explicitly (the inline arithmetic above deserved a
// hand-check, and C is the honest answer):
JOURNEYS.push(
  {
    id: 'jd-a',
    steps: [
      {
        clusterId: 'extraction',
        prompt: `Extract as JSON: {"regions":[{"name":..,"units":..,"price":..,"returns":..}, ...]} from:\nRegion A sold 1240 units at $18 each. Region B sold 890 units at $22. Region C sold 2100 units at $15. Returns: A 40 units, B 10, C 300.\n\nRespond with ONLY the JSON.`,
      },
      {
        clusterId: 'multi-step-reasoning',
        prompt: `Given this data:\n{{prev}}\n\nCompute net units per region (units minus returns) and net revenue per region (net units times price). Show the arithmetic, then end with exactly two lines:\nTOTAL_NET_UNITS: <number>\nTOP_REGION_BY_NET_REVENUE: <name letter only>`,
      },
      {
        clusterId: 'extraction',
        prompt: `From the analysis below, produce ONLY this JSON: {"total_net_units": <number>, "top_region_by_net_revenue": "<letter>"}\n\n{{prev}}`,
      },
    ],
    check: { kind: 'field-match', fields: { total_net_units: '3880', top_region_by_net_revenue: 'C' } },
  },
  {
    id: 'jd-b',
    steps: [
      {
        clusterId: 'extraction',
        prompt: `Extract as JSON {"plans":[{"name":..,"seats":..,"monthly":..}]} from: "The Starter plan is $8/mo for up to 3 seats. Team is $40/mo for 10 seats. Scale is $150/mo for 50 seats."\n\nRespond with ONLY the JSON.`,
      },
      {
        clusterId: 'multi-step-reasoning',
        prompt: `Given:\n{{prev}}\n\nA company needs 23 seats. They can buy multiple subscriptions of any one plan. For each plan compute the subscriptions needed for ≥23 seats and the total monthly cost; then end with exactly one line:\nCHEAPEST_PLAN: <name>` ,
      },
      {
        clusterId: 'extraction',
        prompt: `From the analysis below, produce ONLY this JSON: {"cheapest_plan": "<name>"}\n\n{{prev}}`,
      },
    ],
    // Starter: 8 subs ≥24 seats = $64; Team: 3 subs = 30 seats = $120; Scale: 1 = $150 → Starter.
    check: { kind: 'field-match', fields: { cheapest_plan: 'Starter' } },
  },
  {
    id: 'jd-c',
    steps: [
      {
        clusterId: 'summarization',
        prompt: `Summarize the change window in ONE sentence keeping every number and date: "The maintenance window moved from Sunday March 2 to Sunday March 9, runs 01:00-05:00 UTC, and failover to the Vale region completes within about 90 seconds."\n\nRespond with only the sentence.`,
      },
      {
        clusterId: 'extraction',
        prompt: `From this sentence produce ONLY the JSON {"new_date": "<Month D>", "window_utc": "<HH:MM-HH:MM>", "failover_seconds": <number>}:\n{{prev}}`,
      },
    ],
    check: { kind: 'field-match', fields: { new_date: ['March 9', 'Mar 9'], window_utc: ['01:00-05:00', '1:00-5:00'], failover_seconds: '90' } },
  },
);
