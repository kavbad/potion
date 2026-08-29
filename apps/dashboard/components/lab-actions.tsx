'use client';
// Lab client components (Step 8 — the novice loop, ugly ON PURPOSE).
//
// Honesty rules carried into the UI:
//  · narration is POLLING over durable rows (1.5s) — the timeline IS the
//    checkpoint record; nothing streams, nothing is invented;
//  · the cost ticker shows METERED truth and the labeled "est." figure as
//    TWO numbers — never a blended total;
//  · anything not live-evidenced renders a SIMULATED badge;
//  · declared superpowers render their typed not-connected badge.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const box: React.CSSProperties = { border: '1px solid #ccc', padding: 12, marginBottom: 12 };
const badge: React.CSSProperties = {
  display: 'inline-block', padding: '1px 6px', marginLeft: 6,
  fontSize: 11, border: '1px solid #999', borderRadius: 3, verticalAlign: 'middle',
};

export function SimulatedBadge({ simulated }: { simulated: boolean }) {
  return simulated ? <span style={{ ...badge, background: '#fef3c7' }}>SIMULATED</span> : null;
}

export function NotConnectedBadge() {
  return <span style={{ ...badge, background: '#fee2e2' }}>not-connected</span>;
}

// ---------------------------------------------------------------------------
// InfoDot — the click-to-understand affordance on every field (operator
// feedback 2026-08-27: labels must explain themselves without squinting).
// Sits OUTSIDE the <label> element so opening it never focuses the field.
// ---------------------------------------------------------------------------

export function InfoDot({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // Anchor side decided at open time from the dot's real position, so a
  // dot near the right viewport edge opens leftward instead of clipping.
  const [side, setSide] = useState<'left' | 'right'>('left');
  const btn = useRef<HTMLButtonElement | null>(null);
  return (
    <span className="relative inline-block">
      <button
        ref={btn}
        type="button"
        aria-label={`What does “${label}” mean?`}
        aria-expanded={open}
        onClick={() => {
          const r = btn.current?.getBoundingClientRect();
          if (r) setSide(r.left + 300 > window.innerWidth ? 'right' : 'left');
          setOpen((o) => !o);
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-faint font-mono text-[11px] leading-none text-faint hover:border-accent hover:text-accent"
        data-testid={`info-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}
      >
        i
      </button>
      {open ? (
        <span
          role="note"
          className={`absolute top-6 z-20 block w-72 border border-[#c4bfb2] bg-white px-4 py-3 text-left font-sans text-[13px] font-normal normal-case leading-relaxed tracking-normal text-soft shadow-paper ${side === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Interview form (the Step 6 four questions, one plain form) — daylight,
// self-explaining, and CLOSED-LOOP: a cluster-uncertain draft renders its
// candidates as clickable answers that resubmit with clusterChoice; a
// missing-evidence gap renders as the honest stop it is (nothing to answer).
// ---------------------------------------------------------------------------

interface GenerateResponse {
  kind?: 'complete' | 'draft' | 'refused';
  harnessHash?: string;
  name?: string;
  clusterId?: string;
  spec?: {
    mission?: { kind?: 'task' | 'standing'; goal?: string; doneDefinition?: string };
    fuel?: { maxUsdPerRun?: number };
    superpowers?: Array<{ id: string }>;
    rules?: string[];
    memory?: { enabled?: boolean };
    checkIns?: Array<{ trigger: string; fraction?: number; schedule?: string }>;
  };
  sidecar?: {
    choices?: Array<{ basis?: { frontierVersion?: number; strategyHash?: string } }>;
    workProfile?: string[];
  };
  gaps?: Array<{ code: string; question?: string; candidates?: string[]; clusterId?: string }>;
  reason?: string;
  detail?: string;
  error?: { message?: string };
}

/** Mirrors @potion/lab-gen fuelFromWorth (WORTH_TO_FUEL_RATIO 0.25,
 * cent-rounded, clamped [$0.05, $5]) — a display preview only; the server
 * derives the real cap. */
function fuelPreview(worthUsd: number): number | null {
  if (!Number.isFinite(worthUsd) || worthUsd <= 0) return null;
  return Math.min(Math.max(Math.round(worthUsd * 0.25 * 100) / 100, 0.05), 5);
}

/** The birth sequence — the moment between "Hire" and the specimen page.
 * Every line is a REAL parameter from the 201 response revealing in order;
 * nothing is invented and nothing spins. The operator walks to the worker
 * instead of being teleported. */
function BirthSequence({ body }: { body: GenerateResponse }) {
  const basis = body.sidecar?.choices?.[0]?.basis;
  const powers = body.spec?.superpowers ?? [];
  // The work profile — the genome's headline organ (2026-08-27): a real
  // agent's run is a mix of kinds, and serving routes each step by its
  // kind. One kind is information too, so the profile always shows.
  const profile = body.sidecar?.workProfile ?? (body.clusterId ? [body.clusterId] : []);
  const profileLine =
    profile.length > 1
      ? `mostly ${profile[0]} · also ${profile.slice(1).join(', ')} — each step is routed to the model measured best for its kind`
      : `${profile[0] ?? '—'} — each step is still routed by its kind as the work unfolds`;
  const rules = body.spec?.rules ?? [];
  const checkIns = body.spec?.checkIns ?? [];
  const checkInWords = [
    ...(checkIns.some((c) => c.trigger === 'before-external-action') ? ['asks before every external action'] : []),
    ...(checkIns.some((c) => c.trigger === 'on-budget-fraction') ? ['checks in at half its budget'] : []),
    ...(checkIns.filter((c) => c.trigger === 'cron').map((c) => {
      const words: Record<string, string> = {
        '0 * * * *': 'hourly', '0 9 * * *': 'daily at 9:00', '0 9 * * 1': 'weekly, Monday 9:00',
      };
      return `on a schedule — ${words[c.schedule ?? ''] ?? c.schedule ?? 'cron'}`;
    })),
  ];
  const mission = body.spec?.mission;
  const lines: Array<{ k: string; v: string }> = [
    { k: 'mission understood', v: mission?.goal ?? '—' },
    { k: 'named', v: body.name ?? '—' },
    { k: 'work profile', v: profileLine },
    {
      k: 'brain, per step',
      v: basis
        ? `your router picks per step · anchor: frontier v${basis.frontierVersion} · strategy ${(basis.strategyHash ?? '').slice(0, 8)}`
        : '—',
    },
    ...(mission?.kind === 'task' && mission.doneDefinition !== undefined
      ? [{ k: 'done when', v: mission.doneDefinition }]
      : []),
    ...(rules.length > 0
      ? [{ k: `rules · ${rules.length}`, v: rules[0]! + (rules.length > 1 ? ` (+${rules.length - 1} more)` : '') }]
      : []),
    ...(checkInWords.length > 0 ? [{ k: 'checks in', v: checkInWords.join(' · ') }] : []),
    {
      k: 'spending cap',
      v: body.spec?.fuel?.maxUsdPerRun !== undefined ? `$${body.spec.fuel.maxUsdPerRun.toFixed(2)} per run · hard stop` : '—',
    },
    {
      k: 'memory',
      v: body.spec?.memory?.enabled === true ? 'keeps memory between checks — you can read and edit it' : 'none — each run starts fresh',
    },
    powers.length > 0
      ? { k: 'accounts declared', v: `${powers.map((p) => p.id).join(', ')} — asks you before every external action` }
      : { k: 'external touch', v: 'none — this worker only thinks and writes' },
    { k: 'born', v: 'fully supervised — autonomy must be earned, per kind of action' },
  ];
  const [shown, setShown] = useState(1);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(lines.length);
      return;
    }
    const t = setInterval(() => setShown((n) => (n >= lines.length ? n : n + 1)), 420);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <div className="mt-4" data-testid="birth-sequence">
      <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-accent">your worker, as it was built</div>
      <dl className="mt-3 border-l-2 border-accent/30 pl-4">
        {lines.slice(0, shown).map((l) => (
          <div key={l.k} className="py-1.5">
            <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-faint">{l.k}</dt>
            <dd className="mt-0.5 text-[14px] leading-snug text-ink">{l.v}</dd>
          </div>
        ))}
      </dl>
      {shown >= lines.length && body.harnessHash ? (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <a
            href={`/lab/harness/${body.harnessHash}?born=1`}
            className="inline-block bg-ink px-5 py-2.5 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90"
            data-testid="birth-open"
          >
            Meet {body.name ?? 'your worker'} →
          </a>
          <a
            href={`/lab/harness/${body.harnessHash}#machinery`}
            className="font-mono text-[12.5px] text-soft underline hover:text-accent"
            data-testid="birth-machinery"
          >
            open the machinery — the spec file, editable to the detail
          </a>
        </div>
      ) : null}
    </div>
  );
}

const FIELD_CLS =
  'w-full border border-[#c4bfb2] bg-white px-3 py-2 font-mono text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none';
const LABEL_ROW = 'flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.13em] text-soft';

/** Alias → connector-id hints for the account autofill. An alias only
 * fires when the target id actually exists in the org's catalog — the
 * suggestion never invents a connector. */
const ACCOUNT_ALIASES: Record<string, string[]> = {
  code: ['analyze', 'analyse', 'compute', 'calculate', 'spreadsheet', 'xlsx', 'chart', 'plot', 'csv', 'dataset', 'script', 'python'],
  gmail: ['email', 'emails', 'inbox', 'mail', 'mailbox'],
  github: ['repo', 'repos', 'repository', 'pull request', 'pull requests', 'commit'],
  slack: ['channel', 'dm'],
  notion: ['wiki'],
  'google-calendar': ['calendar', 'meeting', 'meetings'],
  'google-sheets': ['spreadsheet', 'spreadsheets', 'sheet', 'sheets'],
  'google-drive': ['drive', 'files', 'documents'],
  web: ['website', 'websites', 'web', 'feeds', 'rss', 'blog', 'blogs', 'changelog', 'changelogs', 'pricing page', 'pricing pages', 'news', 'url', 'download', 'link'],
};

/** Deterministic account detection from the job text: direct catalog-name
 * mentions first, then aliases. Pure — same goal, same suggestions. */
function detectAccounts(goal: string, catalog: Array<{ connectorId: string; displayName: string }>): string[] {
  const text = ` ${goal.toLowerCase()} `;
  const hits = new Set<string>();
  for (const c of catalog) {
    if (text.includes(c.connectorId.toLowerCase()) || text.includes(c.displayName.toLowerCase())) {
      hits.add(c.connectorId);
    }
  }
  for (const [id, aliases] of Object.entries(ACCOUNT_ALIASES)) {
    if (!catalog.some((c) => c.connectorId === id)) continue;
    if (aliases.some((a) => text.includes(` ${a} `) || text.includes(` ${a},`) || text.includes(` ${a}.`))) hits.add(id);
  }
  return [...hits].sort();
}

const STANDING_HINT = /\b(daily|weekly|hourly|every|each|monitor|monitors|watch|watches|ongoing|continuously|whenever|keep)\b/i;

/** The showcase example (operator, 2026-08-28). An authored example ships
 * with its author's answer to the kind-of-work question: EXAMPLE_CLUSTER is
 * sent as the authoritative clusterChoice — but ONLY while the goal is
 * still verbatim EXAMPLE_GOAL. The moment the operator makes the mission
 * their own, the choice is dropped and the real interpretation runs (a
 * stale authored answer on an edited mission would silently misclassify —
 * the exact failure the never-silent rule exists to prevent). */
const EXAMPLE_GOAL =
  'Every Monday morning, download the CSV at https://raw.githubusercontent.com/plotly/datasets/master/tips.csv, analyze revenue and tipping by day of the week, and deliver a labeled chart plus a spreadsheet of the numbers with a three-line summary';
const EXAMPLE_CLUSTER = 'agentic-tool-use';

export function InterviewForm() {
  const router = useRouter();
  const [goal, setGoal] = useState('');
  const [kind, setKind] = useState<'task' | 'standing'>('task');
  const [done, setDone] = useState('');
  const [accounts, setAccounts] = useState('');
  const [worth, setWorth] = useState('1');
  // The recipe card (2026-08-27): each field is one consideration a good
  // agent-builder weighs — the form itself does the teaching, so nobody
  // faces a blank prompt wondering what to think about. All optional; a
  // blank field is drafted from the job by the build, never invented.
  const [qualityBar, setQualityBar] = useState('');
  const [produces, setProduces] = useState('');
  const [example, setExample] = useState('');
  const [never, setNever] = useState('');
  const [whenUnsure, setWhenUnsure] = useState<'ask-first' | 'press-on'>('ask-first');
  const [cadence, setCadence] = useState<'' | 'hourly' | 'daily' | 'weekly'>('');
  const [exampleOpen, setExampleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [born, setBorn] = useState<GenerateResponse | null>(null);
  const [catalog, setCatalog] = useState<Array<{ connectorId: string; displayName: string }>>([]);
  useEffect(() => {
    fetch('/api/lab/connectors', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const list = (b as { connectors?: Array<{ connectorId: string; displayName: string }> } | null)?.connectors;
        if (list) setCatalog(list.map((c) => ({ connectorId: c.connectorId, displayName: c.displayName })));
      })
      .catch(() => null);
  }, []);

  const submit = useCallback(async (clusterChoice?: string) => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/lab/harnesses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          answers: {
            goal,
            kind,
            ...(kind === 'task' && done ? { doneDefinition: done } : {}),
            accounts: accounts.split(',').map((s) => s.trim()).filter(Boolean),
            worthUsd: Number(worth),
            ...(clusterChoice !== undefined
              ? { clusterChoice }
              : goal === EXAMPLE_GOAL
                ? { clusterChoice: EXAMPLE_CLUSTER }
                : {}),
            ...(qualityBar.trim() ? { qualityBar: qualityBar.trim() } : {}),
            ...(produces.trim() ? { produces: produces.trim() } : {}),
            ...(example.trim() ? { exampleResult: example.trim() } : {}),
            ...(never.trim()
              ? { constraints: never.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20) }
              : {}),
            whenUnsure,
            ...(kind === 'standing' && cadence !== '' ? { cadence } : {}),
          },
        }),
      });
      const body = (await res.json()) as GenerateResponse;
      if (res.status === 201 && body.harnessHash) {
        setBorn(body); // the birth sequence, then the operator walks over
        router.prefetch(`/lab/harness/${body.harnessHash}`);
      } else {
        setResult(body);
      }
    } finally {
      setBusy(false);
    }
  }, [goal, kind, done, accounts, worth, qualityBar, produces, example, never, whenUnsure, cadence, router]);

  // "Show me a great one" (operator, 2026-08-28): one click fills every
  // field with a coherent example worker, so the card teaches by a worked
  // example as well as by its questions. Deterministic, client-side,
  // everything editable afterwards — a starting point, never a submission.
  const fillExample = useCallback(() => {
    setGoal(EXAMPLE_GOAL);
    setKind('standing');
    setCadence('weekly');
    setAccounts('web, code');
    setWorth('3');
    setWhenUnsure('ask-first');
    setQualityBar('every number computed from the actual file, never estimated; the chart labeled and readable');
    setProduces('an xlsx of the by-day numbers, a png chart, and a three-line summary');
    setNever('never fabricate a number — if the download fails, say so and stop');
    setExample(
      'Revenue peaks Saturday ($1,778.40 across 87 checks); Friday is the weakest full day.\nTipping runs 15.9% overall — dinner tips better than lunch (16.1% vs 15.6%).\nFiles: tips-by-day.xlsx · revenue-by-day.png',
    );
    setExampleOpen(true);
  }, []);

  if (born !== null) return <BirthSequence body={born} />;

  const cap = fuelPreview(Number(worth));
  // Autofill (operator, 2026-08-27): the job text already names what it
  // touches — offer it back as tap-to-add chips, never silent writes.
  const currentAccounts = accounts.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const accountSuggestions = goal.trim().length >= 8
    ? detectAccounts(goal, catalog).filter((id) => !currentAccounts.includes(id))
    : [];
  const suggestStanding = kind === 'task' && STANDING_HINT.test(goal);
  const gaps = result?.gaps ?? [];
  const clusterGap = gaps.find((g) => g.code === 'cluster-uncertain');
  const evidenceGaps = gaps.filter((g) => g.code !== 'cluster-uncertain');

  return (
    <div className="mt-4" data-testid="interview-form">
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={fillExample}
          className="border border-accent/50 px-3 py-1.5 font-mono text-[12.5px] text-accent hover:bg-accent hover:text-white"
          data-testid="fill-example"
        >
          show me a great one — fill every field with an example
        </button>
        <span className="font-mono text-[12px] text-faint">a starting point, not a submission — edit anything, then hire</span>
      </div>
      <div>
        <div className={LABEL_ROW}>
          <label htmlFor="lab-q-goal">the job, in your words</label>
          <InfoDot label="the job">
            Describe the job in plain words, like you would to a new hire. Potion reads this and
            builds the worker around it: what kind of work it is, which measured models fit it, and
            what &ldquo;done&rdquo; means. You are not writing a prompt — you are describing a job.
          </InfoDot>
        </div>
        <textarea
          id="lab-q-goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={2}
          placeholder="Watch our portfolio companies, research meaningful updates, draft me a daily brief…"
          className={`${FIELD_CLS} mt-1.5 resize-none text-[15px]`}
          data-testid="q-goal"
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <div className={LABEL_ROW}>
            <label htmlFor="lab-q-kind">one-off or standing</label>
            <InfoDot label="one-off or standing">
              A <b>one-off task</b> runs, finishes, and reports done. A <b>standing mission</b> never
              finishes: it works in cycles (each cycle is a &ldquo;check&rdquo;), keeps memory
              between checks, and checks in with you partway through its budget.
            </InfoDot>
          </div>
          <select
            id="lab-q-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'task' | 'standing')}
            className={`${FIELD_CLS} mt-1.5`}
            data-testid="q-kind"
          >
            <option value="task">one-off task</option>
            <option value="standing">standing mission</option>
          </select>
          {suggestStanding && (
            <button
              type="button"
              onClick={() => setKind('standing')}
              className="mt-1.5 border border-accent/50 px-2 py-0.5 font-mono text-[12px] text-accent hover:bg-accent hover:text-white"
              data-testid="suggest-standing"
            >
              sounds like a standing mission — switch
            </button>
          )}
        </div>
        <div>
          <div className={LABEL_ROW}>
            <label htmlFor="lab-q-accounts">accounts it touches</label>
            <InfoDot label="accounts it touches">
              Name the outside services this job needs — gmail, github, slack. Naming them here only
              puts them on the worker&rsquo;s record: <b>nothing is connected yet</b>, and the worker
              asks you before every external action. You connect accounts on the worker&rsquo;s page
              after it is born.
            </InfoDot>
          </div>
          <input
            id="lab-q-accounts"
            value={accounts}
            onChange={(e) => setAccounts(e.target.value)}
            placeholder="github, slack — or none"
            className={`${FIELD_CLS} mt-1.5`}
            data-testid="q-accounts"
          />
          {accountSuggestions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="account-suggestions">
              <span className="font-mono text-[11.5px] text-faint">from the job:</span>
              {accountSuggestions.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setAccounts((cur) => (cur.trim() ? `${cur.replace(/,\s*$/, '')}, ${id}` : id))}
                  className="border border-accent/50 px-2 py-0.5 font-mono text-[12px] text-accent hover:bg-accent hover:text-white"
                >
                  + {id}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className={LABEL_ROW}>
            <label htmlFor="lab-q-worth">one {kind === 'task' ? 'run' : 'check'} is worth ($)</label>
            <InfoDot label="worth">
              What one completed {kind === 'task' ? 'run of this job' : 'check of this mission'} is
              worth <b>to you</b>, in dollars. It sets the worker&rsquo;s hard spending cap — a
              quarter of the worth per {kind === 'task' ? 'run' : 'check'} (between $0.05 and $5) —
              so the work is never allowed to cost more than a fraction of what it&rsquo;s worth. A
              {' '}{kind === 'task' ? 'run' : 'check'} that hits the cap stops. You can change this
              anytime.
            </InfoDot>
          </div>
          <input
            id="lab-q-worth"
            value={worth}
            onChange={(e) => setWorth(e.target.value)}
            className={`${FIELD_CLS} mt-1.5`}
            data-testid="q-worth"
          />
          <p className="mt-1 font-mono text-[12px] text-faint">
            {cap !== null
              ? <>
                  → hard spending cap ≈ ${cap.toFixed(2)} per {kind === 'task' ? 'run' : 'check'}
                  {kind === 'standing' && cadence !== '' ? (
                    <> · worst case ≈ ${(cap * ({ hourly: 730.5, daily: 30.44, weekly: 4.35 } as const)[cadence]).toFixed(2)}/month at this cadence</>
                  ) : null}
                </>
              : 'enter a positive dollar amount'}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {kind === 'task' ? (
          <div>
            <div className={LABEL_ROW}>
              <label htmlFor="lab-q-done">how it knows it&apos;s done</label>
              <InfoDot label="done">
                An objectively checkable finish line — &ldquo;the brief is in my inbox&rdquo;,
                &ldquo;the spreadsheet has a row per company&rdquo;. The worker uses it to decide when
                to stop and report, instead of running forever or quitting early. Leave it blank and
                Potion drafts one from the job — you&rsquo;ll see it on the built worker.
              </InfoDot>
            </div>
            <input
              id="lab-q-done"
              value={done}
              onChange={(e) => setDone(e.target.value)}
              placeholder="the brief is in my inbox"
              className={`${FIELD_CLS} mt-1.5`}
              data-testid="q-done"
            />
          </div>
        ) : (
          <div>
            <div className={LABEL_ROW}>
              <label htmlFor="lab-q-cadence">how often it checks</label>
              <InfoDot label="cadence">
                A standing mission works in cycles. Pick a rhythm and the worker also checks in with
                you on that schedule — a scheduled question, on its record, that you answer. Leave it
                unset and it still checks in with you partway through each cycle&rsquo;s budget.
              </InfoDot>
            </div>
            <select
              id="lab-q-cadence"
              value={cadence}
              onChange={(e) => setCadence(e.target.value as typeof cadence)}
              className={`${FIELD_CLS} mt-1.5`}
              data-testid="q-cadence"
            >
              <option value="">no schedule — budget check-ins only</option>
              <option value="hourly">hourly</option>
              <option value="daily">daily, 9:00</option>
              <option value="weekly">weekly, Monday 9:00</option>
            </select>
          </div>
        )}
        <div>
          <div className={LABEL_ROW}>
            <label htmlFor="lab-q-unsure">when unsure, it should</label>
            <InfoDot label="when unsure">
              Escalation is a design choice, so it is asked, not assumed. <b>Ask first</b> adds a
              check-in halfway through the budget — the worker pauses and shows you where it is.
              <b> Press on</b> lets it use its own judgment to the finish under the hard cap. Either
              way, it always asks before any external action until it earns that autonomy.
            </InfoDot>
          </div>
          <select
            id="lab-q-unsure"
            value={whenUnsure}
            onChange={(e) => setWhenUnsure(e.target.value as 'ask-first' | 'press-on')}
            className={`${FIELD_CLS} mt-1.5`}
            data-testid="q-unsure"
          >
            <option value="ask-first">ask first — check in at half budget</option>
            <option value="press-on">press on — report at the end</option>
          </select>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className={LABEL_ROW}>
            <label htmlFor="lab-q-bar">done well means…</label>
            <InfoDot label="done well means">
              Quality needs a definition — &ldquo;finished&rdquo; and &ldquo;finished well&rdquo; are
              different claims. Whatever you write here becomes a standing rule the worker reads on
              every single step: &ldquo;covers every company, no filler, numbers sourced&rdquo;.
              Optional — but the workers with a stated bar are the ones worth keeping.
            </InfoDot>
          </div>
          <input
            id="lab-q-bar"
            value={qualityBar}
            onChange={(e) => setQualityBar(e.target.value)}
            placeholder="specific, sourced, no filler"
            className={`${FIELD_CLS} mt-1.5`}
            data-testid="q-bar"
          />
        </div>
        <div>
          <div className={LABEL_ROW}>
            <label htmlFor="lab-q-produces">it should produce…</label>
            <InfoDot label="it should produce">
              Output has a shape — a three-bullet summary, a draft reply, a table, a ranked list.
              Naming the shape becomes a standing rule the worker reads on every step, and is the
              single cheapest way to get what you actually wanted.
            </InfoDot>
          </div>
          <input
            id="lab-q-produces"
            value={produces}
            onChange={(e) => setProduces(e.target.value)}
            placeholder="a three-bullet summary with links"
            className={`${FIELD_CLS} mt-1.5`}
            data-testid="q-produces"
          />
        </div>
      </div>
      <div className="mt-4">
        <div className={LABEL_ROW}>
          <label htmlFor="lab-q-never">it must never…</label>
          <InfoDot label="it must never">
            Scope has edges — say where they are, one per line: &ldquo;never email anyone&rdquo;,
            &ldquo;never touch the main branch&rdquo;. Each line becomes a hard rule on the
            worker&rsquo;s record, verbatim, read on every step. Rules arrive whole or the build
            refuses — they are never silently trimmed.
          </InfoDot>
        </div>
        <textarea
          id="lab-q-never"
          value={never}
          onChange={(e) => setNever(e.target.value)}
          rows={2}
          placeholder={'never email anyone\nnever spend outside its budget'}
          className={`${FIELD_CLS} mt-1.5 resize-none`}
          data-testid="q-never"
        />
      </div>
      <details className="mt-4" open={exampleOpen} onToggle={(e) => setExampleOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer font-mono text-[12px] uppercase tracking-[0.13em] text-faint hover:text-accent">
          paste an example of a great result · optional
        </summary>
        <div className="mt-2">
          <div className={LABEL_ROW}>
            <label htmlFor="lab-q-example">a great result looks like…</label>
            <InfoDot label="a great result">
              Concreteness beats adjectives: one pasted example of what you&rsquo;d love to receive
              teaches the build more than a paragraph of description. It is read while your worker is
              being designed — it is not stored on the worker, and secrets are refused before
              anything is read.
            </InfoDot>
          </div>
          <textarea
            id="lab-q-example"
            value={example}
            onChange={(e) => setExample(e.target.value)}
            rows={4}
            placeholder="ACME — raised a $12M Series A (TechCrunch, Tue) — relevant to us because…"
            className={`${FIELD_CLS} mt-1.5 resize-y`}
            data-testid="q-example"
          />
        </div>
      </details>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button
          onClick={() => void submit()}
          disabled={busy || goal.length === 0}
          className="bg-ink px-5 py-2.5 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-30"
          data-testid="interview-submit"
        >
          {busy ? 'Building your worker…' : 'Hire this worker'}
        </button>
        <span className="font-mono text-[12px] text-faint">
          born fully supervised · hard budget · you approve every external action until it earns otherwise
        </span>
      </div>

      {/* One more question — ANSWERABLE: the candidates are the answer. */}
      {clusterGap ? (
        <div className="mt-4 border border-accent/40 bg-white px-4 py-3.5" data-testid="gen-draft">
          <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-accent">one more question</span>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink">
            I couldn&rsquo;t confidently tell what kind of work this is. Pick the closest — your
            answer decides which measured evidence the worker&rsquo;s brain is chosen from:
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {(clusterGap.candidates ?? []).map((c) => (
              <button
                key={c}
                onClick={() => void submit(c)}
                disabled={busy}
                className="border border-[#c4bfb2] bg-[#fbfaf7] px-3.5 py-2 font-mono text-[13px] text-ink hover:border-accent hover:text-accent disabled:opacity-40"
                data-testid={`cluster-answer-${c}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Missing live evidence — an honest stop, not a question. */}
      {evidenceGaps.length > 0 ? (
        <div className="mt-4 border border-[#c4bfb2] bg-white px-4 py-3.5" data-testid="gen-draft">
          <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-warn">an honest stop</span>
          <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
            A worker is only ever born on live, measured evidence — and Potion doesn&rsquo;t have it
            for this kind of work yet, so it refuses to build on guesses. This changes as the
            research engine measures more kinds of work.
          </p>
          <ul className="mt-2 list-disc pl-5 font-mono text-[12.5px] text-faint">
            {evidenceGaps.map((g, i) => <li key={i}>{g.question ?? g.code}</li>)}
          </ul>
        </div>
      ) : null}

      {result?.kind === 'refused' ? (
        <div className="mt-4 border border-refuse/50 bg-white px-4 py-3 text-[13.5px] text-refuse" data-testid="gen-refused">
          <b>Refused ({result.reason}):</b> {result.detail}
        </div>
      ) : null}
      {result?.error ? <div className="mt-4 text-[13.5px] text-refuse">{result.error.message}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start-trial button (harness page)
// ---------------------------------------------------------------------------

export function StartTrialButton({ harnessHash }: { harnessHash: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/lab/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harnessHash }),
      });
      const body = (await res.json()) as { runId?: string; error?: { message?: string } };
      if (res.status === 202 && body.runId) router.push(`/lab/run/${body.runId}`);
      else setError(body.error?.message ?? `start failed (${res.status})`);
    } finally {
      setBusy(false);
    }
  }, [harnessHash, router]);
  return (
    <span>
      <button onClick={start} disabled={busy} data-testid="start-trial">
        {busy ? 'Starting…' : 'Run a trial'}
      </button>
      {error ? <span style={{ marginLeft: 8 }}>{error}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Run view: poll durable rows, narrate, ticker, check-in answer, kill
// ---------------------------------------------------------------------------

interface RunStep {
  seq: number;
  kind: 'model' | 'tool' | 'check-in';
  at: string;
  slot: 'brain' | 'tools' | null;
  excerpt: string;
  estCostUsd?: number;
  meteredCostUsd?: number | null;
  costLabel?: 'metered' | 'est.';
  provenance?: string | null;
  simulated?: boolean;
}

interface RunResponse {
  runId: string;
  harnessHash: string;
  harnessName: string;
  state: string;
  stateReason: string | null;
  pendingQuestion: string | null;
  superpowers: Array<{ id: string; status: 'not-connected' }>;
  steps: RunStep[];
  cost: { meteredUsd: number; estPendingUsd: number };
  error?: { message?: string };
}

const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);

export function RunView({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunResponse | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    const res = await fetch(`/api/lab/runs/${runId}`);
    if (res.ok) setRun((await res.json()) as RunResponse);
  }, [runId]);

  useEffect(() => {
    void poll();
    timer.current = setInterval(() => void poll(), 1500);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [poll]);

  useEffect(() => {
    if (run && TERMINAL.has(run.state) && timer.current) clearInterval(timer.current);
  }, [run]);

  const sendAnswer = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/lab/runs/${runId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      setAnswer('');
      // Resume polling — the answered leg writes new durable rows.
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => void poll(), 1500);
    } finally {
      setBusy(false);
    }
  }, [runId, answer, poll]);

  const kill = useCallback(async () => {
    await fetch(`/api/lab/runs/${runId}/kill`, { method: 'POST' });
    void poll();
  }, [runId, poll]);

  if (run === null) return <p>Loading run…</p>;

  const anySimulated = run.steps.some((s) => s.simulated === true);
  return (
    <div data-testid="run-view" data-state={run.state}>
      <h2>
        {run.harnessName} <span style={badge}>{run.state}</span>
        <SimulatedBadge simulated={anySimulated} />
      </h2>
      {run.stateReason ? <p data-testid="state-reason">{run.stateReason}</p> : null}
      {run.superpowers.length > 0 ? (
        <p data-testid="run-posture">
          This trial ran <b>brain-only</b> — declared superpowers:{' '}
          {run.superpowers.map((s) => (
            <span key={s.id}>
              {s.id}
              <NotConnectedBadge />{' '}
            </span>
          ))}
        </p>
      ) : null}
      <p data-testid="cost-ticker">
        Cost so far: <b>${run.cost.meteredUsd.toFixed(4)}</b> metered
        {run.cost.estPendingUsd > 0 ? (
          <span>
            {' '}
            + <b>${run.cost.estPendingUsd.toFixed(4)}</b> <i>est.</i> (unresolved steps)
          </span>
        ) : null}
      </p>
      {run.pendingQuestion !== null && run.state === 'awaiting-human' ? (
        <div style={{ ...box, background: '#eff6ff' }} data-testid="check-in">
          <b>The harness asks:</b> {run.pendingQuestion}
          <p>
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} size={60} data-testid="answer-input" />
            <button onClick={sendAnswer} disabled={busy || answer.length === 0} data-testid="answer-submit">
              Answer
            </button>
          </p>
        </div>
      ) : null}
      <ol data-testid="narration">
        {run.steps.map((s) => (
          <li key={s.seq} style={{ marginBottom: 6 }}>
            <b>{s.kind}</b>
            {s.slot ? <span style={badge}>{s.slot}</span> : null}
            {s.kind === 'model' ? <SimulatedBadge simulated={s.simulated === true} /> : null}
            {s.kind === 'model' ? (
              <span style={{ marginLeft: 6, fontSize: 12 }}>
                {s.costLabel === 'metered'
                  ? `$${(s.meteredCostUsd ?? 0).toFixed(4)} metered`
                  : `$${(s.estCostUsd ?? 0).toFixed(4)} est.`}
              </span>
            ) : null}
            <div style={{ whiteSpace: 'pre-wrap' }}>{s.excerpt}</div>
          </li>
        ))}
      </ol>
      <p>
        {!TERMINAL.has(run.state) ? (
          <button onClick={kill} data-testid="kill-run">
            Stop this run
          </button>
        ) : (
          <a href={`/lab/run/${runId}/report`} data-testid="report-link">
            Open the report →
          </a>
        )}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory editor (plain-language v1)
// ---------------------------------------------------------------------------

export function MemoryEntryEditor({
  harnessHash,
  entryKey,
  initialText,
}: {
  harnessHash: string;
  entryKey: string;
  initialText: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const save = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/lab/memory/${harnessHash}/${encodeURIComponent(entryKey)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [harnessHash, entryKey, text, router]);
  const remove = useCallback(async () => {
    // Deletion is PERMANENT and immediate — no tombstone (stated semantics).
    if (!window.confirm(`Delete memory '${entryKey}' permanently? There is no undo.`)) return;
    setBusy(true);
    try {
      await fetch(`/api/lab/memory/${harnessHash}/${encodeURIComponent(entryKey)}`, { method: 'DELETE' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [harnessHash, entryKey, router]);
  return (
    <span>
      <input value={text} onChange={(e) => setText(e.target.value)} size={50} data-testid={`memory-edit-${entryKey}`} />
      <button onClick={save} disabled={busy}>
        Save
      </button>
      <button onClick={remove} disabled={busy}>
        Delete (permanent)
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connector panel (Step 10) — the filament's control surface: catalog +
// grant STATUSES only (token material structurally absent from the API),
// Connect starts the PKCE flow (admin), Revoke is the typed cut.
// ---------------------------------------------------------------------------

interface ConnectorDto {
  connectorId: string;
  displayName: string;
  category: string;
  version: string;
  /** Step 11 honest tiering: the PROOF tier and the CONNECT posture are
   * different claims, so the catalog shows both. */
  tier: 'fixture-authored' | 'fixture-recorded' | 'live-proven';
  connectStatus: 'ready' | 'endpoint-unverified' | 'oauth-unauthored' | 'builtin';
  connectNote: string | null;
  fixtureAgeDays: number | null;
  scopesOffered: string[];
  defaultScopes: string[];
  toolCount: { read: number; act: number };
  tools: Array<{ name: string; action: 'read' | 'act' }>;
  contextTokens: number;
  configured: boolean;
  status: 'not-connected' | 'connected' | 'expired' | 'revoked';
  grant: { scopesGranted: string[]; grantedBy: string; revokedAt: string | null } | null;
}

interface CustomConnectorDto {
  connectorId: string;
  displayName: string;
  tools: Array<{ name: string; action: 'read' | 'act' }>;
  status: 'not-connected' | 'connected' | 'expired' | 'revoked';
  custom: { endpointUrl: string; serverName: string; createdBy: string };
}

const TIER_LABEL: Record<ConnectorDto['tier'], string> = {
  'fixture-authored': 'fixture-authored',
  'fixture-recorded': 'fixture-recorded',
  'live-proven': 'LIVE-PROVEN',
};

const STATUS_LABEL: Record<ConnectorDto['status'], string> = {
  'not-connected': 'not connected',
  connected: 'connected',
  expired: 'expired',
  revoked: 'revoked',
};
const STATUS_CLS: Record<ConnectorDto['status'], string> = {
  'not-connected': 'border-[#c4bfb2] text-soft',
  connected: 'border-kept text-kept',
  expired: 'border-warn text-warn',
  revoked: 'border-refuse text-refuse',
};

function ConnectorRow({
  c, declared, busy, onConnect, onRevoke,
}: {
  c: ConnectorDto;
  declared: boolean;
  busy: boolean;
  onConnect: (id: string) => void;
  onRevoke: (id: string) => void;
}) {
  const chip = 'border px-1.5 py-px font-mono text-[11px] uppercase tracking-[0.08em]';
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-[#d9d5cb] py-2.5 last:border-0"
      data-testid={`connector-${c.connectorId}`}
      data-status={c.status}
    >
      <span className="text-[14px] font-medium text-ink">{c.displayName}</span>
      {/* Step 10 grant badge — the filament state */}
      <span className={`${chip} ${STATUS_CLS[c.status]}`}>{STATUS_LABEL[c.status]}</span>
      {/* Step 11 proof tier — a DIFFERENT claim, never conflated */}
      <span className={`${chip} border-[#c4bfb2] text-faint`} data-testid={`tier-${c.connectorId}`}>
        {TIER_LABEL[c.tier]}
        {c.fixtureAgeDays === null ? '' : ` · ${c.fixtureAgeDays}d old`}
      </span>
      <span className="font-mono text-[12px] text-faint">
        {c.toolCount.read} read / {c.toolCount.act} act
        {c.defaultScopes.length === 0 ? ' · zero-scope default' : ` · default ${c.defaultScopes.length} scope(s)`}
      </span>
      {c.status === 'connected' ? (
        <button
          onClick={() => onRevoke(c.connectorId)}
          disabled={busy}
          className="border border-[#c4bfb2] px-2.5 py-1 text-[12px] text-soft hover:border-refuse hover:text-refuse disabled:opacity-40"
        >
          Revoke
        </button>
      ) : c.connectStatus === 'builtin' ? (
        // P1: a builtin runs inside Potion — no account, no OAuth. Enabling
        // it is a pure permission grant, revocable like any other.
        <button
          onClick={() => onConnect(c.connectorId)}
          disabled={busy}
          title={c.connectNote ?? ''}
          className="bg-ink px-3 py-1 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          data-testid={`enable-${c.connectorId}`}
        >
          Enable — no account needed
        </button>
      ) : c.connectStatus === 'ready' ? (
        <button
          onClick={() => onConnect(c.connectorId)}
          disabled={busy || !c.configured}
          title={c.configured ? '' : 'set the connector client id/secret env vars'}
          className="bg-ink px-3 py-1 text-[12px] font-medium text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
        >
          {c.status === 'not-connected' ? 'Connect' : 'Reconnect'}
        </button>
      ) : (
        // Honest, not broken: a package we cannot reach live says why —
        // in words a person can act on, prominent when the worker needs it.
        <span
          className={`text-[12.5px] leading-snug ${declared ? 'basis-full text-warn' : 'text-faint'}`}
          title={c.connectNote ?? ''}
          data-testid={`unconnectable-${c.connectorId}`}
        >
          built &amp; tested against recordings — a live connection isn&rsquo;t available yet.
          {declared ? ' Until it is, trials run brain-only: the worker reasons and drafts, but touches nothing real.' : ''}
        </span>
      )}
    </li>
  );
}

// BYO-MCP (2026-08-28, the genius door): an admin brings their own MCP
// endpoint. The flow is two-step ON PURPOSE — probe first, so the admin
// REVIEWS the pinned tool surface before registering it (their confirmation
// is what makes them the author of that text; the provenance rule holds).
function ByoEndpointForm({ onRegistered }: { onRegistered: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [bearer, setBearer] = useState('');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [surface, setSurface] = useState<{ serverName: string; tools: Array<{ name: string; description: string }> } | null>(null);

  const probe = useCallback(async () => {
    setBusy(true);
    setErr(null);
    setSurface(null);
    try {
      const res = await fetch('/api/lab/connectors/custom/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), ...(bearer.trim() !== '' ? { bearerToken: bearer.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; reason?: string; surface?: { serverName: string; tools: Array<{ name: string; description: string }> }; error?: { message?: string }; message?: string }
        | null;
      if (res.ok && body?.ok && body.surface) {
        setSurface(body.surface);
        if (name === '') setName(body.surface.serverName.slice(0, 80));
        if (slug === '') setSlug(body.surface.serverName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30));
      } else {
        setErr(body?.reason ?? body?.error?.message ?? body?.message ?? `probe failed (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }, [url, bearer, name, slug]);

  const register = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/lab/connectors/custom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          ...(bearer.trim() !== '' ? { bearerToken: bearer.trim() } : {}),
          slug: slug.trim(),
          displayName: name.trim(),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; reason?: string; error?: { message?: string }; message?: string }
        | null;
      if (res.ok && body?.ok) {
        setOpen(false);
        setUrl(''); setBearer(''); setSlug(''); setName(''); setSurface(null);
        onRegistered();
      } else {
        setErr(body?.reason ?? body?.error?.message ?? body?.message ?? `registration failed (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }, [url, bearer, slug, name, onRegistered]);

  const field = 'w-full border border-[#d9d5cb] bg-white px-2.5 py-1.5 font-mono text-[12.5px] text-ink placeholder:text-faint focus:border-accent focus:outline-none';

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 font-mono text-[12px] uppercase tracking-[0.13em] text-faint hover:text-accent"
        data-testid="byo-open"
      >
        + add your own (mcp endpoint)
      </button>
    );
  }
  return (
    <div className="mt-3 border border-dashed border-[#c4bfb2] bg-white/60 px-4 py-3.5" data-testid="byo-form">
      <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-soft">bring your own endpoint</div>
      <p className="mt-1 text-[12.5px] leading-snug text-soft">
        Any MCP server you run. Potion opens one session, pins the declared tool surface for your
        review, and freezes it — the live server never writes into a worker&apos;s context again. Every
        tool starts supervised.
      </p>
      <div className="mt-2.5 grid gap-2">
        <input className={field} placeholder="https://mcp.yourcompany.com/mcp" value={url} onChange={(e) => { setUrl(e.target.value); setSurface(null); }} data-testid="byo-url" />
        <input className={field} type="password" placeholder="bearer token (optional — sealed, never shown again)" value={bearer} onChange={(e) => { setBearer(e.target.value); setSurface(null); }} data-testid="byo-bearer" />
      </div>
      {surface === null ? (
        <button
          type="button"
          onClick={() => void probe()}
          disabled={busy || url.trim() === ''}
          className="mt-2.5 bg-ink px-3.5 py-1.5 text-[12.5px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
          data-testid="byo-probe"
        >
          {busy ? 'probing…' : 'Probe the endpoint'}
        </button>
      ) : (
        <div className="mt-2.5" data-testid="byo-surface">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-accent">
            pinned surface · {surface.serverName} · {surface.tools.length} tool{surface.tools.length === 1 ? '' : 's'}
          </div>
          <ul className="mt-1 max-h-40 overflow-y-auto border border-[#e4e1d8] bg-white px-3 py-2">
            {surface.tools.map((t) => (
              <li key={t.name} className="py-0.5 text-[12.5px] leading-snug">
                <span className="font-mono text-ink">{t.name}</span>
                <span className="text-soft"> — {t.description === '' ? '(no description)' : t.description}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12px] leading-snug text-soft">
            Registering pins exactly this text as the tools your workers see — you are its author now.
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input className={field} placeholder="slug (e.g. our-crm)" value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="byo-slug" />
            <input className={field} placeholder="display name" value={name} onChange={(e) => setName(e.target.value)} data-testid="byo-name" />
          </div>
          <button
            type="button"
            onClick={() => void register()}
            disabled={busy || slug.trim() === '' || name.trim() === ''}
            className="mt-2.5 bg-ink px-3.5 py-1.5 text-[12.5px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-40"
            data-testid="byo-register"
          >
            {busy ? 'registering…' : 'Register this surface'}
          </button>
        </div>
      )}
      {err ? <p className="mt-2 text-[12.5px] text-refuse" data-testid="byo-error">{err}</p> : null}
      <button type="button" onClick={() => { setOpen(false); setErr(null); setSurface(null); }} className="ml-3 mt-2 font-mono text-[12px] text-faint hover:text-accent">
        cancel
      </button>
    </div>
  );
}

export function ConnectorPanel({ declared = [], role }: { declared?: string[]; role?: 'admin' | 'member' | 'viewer' }) {
  const [connectors, setConnectors] = useState<ConnectorDto[] | null>(null);
  const [custom, setCustom] = useState<CustomConnectorDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/lab/connectors');
    if (res.ok) {
      const body = (await res.json()) as { connectors: ConnectorDto[]; custom?: CustomConnectorDto[] };
      setConnectors(body.connectors);
      setCustom(body.custom ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(
    async (id: string) => {
      setBusy(true);
      setNote(null);
      try {
        const res = await fetch(`/api/lab/connectors/${id}/oauth/start`, { method: 'POST' });
        const body = (await res.json()) as { authorizationUrl?: string; granted?: boolean; error?: { message?: string } };
        if (res.ok && body.granted === true) {
          await load(); // builtin: the grant is minted — no redirect, no vendor
        } else if (res.ok && body.authorizationUrl) {
          window.location.href = body.authorizationUrl; // the operator approves BY HAND
        } else {
          setNote(body.error?.message ?? `connect failed (${res.status})`);
        }
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const revoke = useCallback(
    async (id: string) => {
      if (!window.confirm(`Revoke the ${id} grant? The worker loses this access immediately.`)) return;
      setBusy(true);
      try {
        await fetch(`/api/lab/connectors/${id}/revoke`, { method: 'POST' });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (connectors === null) return null;
  const declaredSet = new Set(declared);
  const declaredRows = connectors.filter((c) => declaredSet.has(c.connectorId));
  const missingDeclared = declared.filter(
    (id) => !connectors.some((c) => c.connectorId === id) && !custom.some((c) => c.connectorId === id),
  );
  const catalogRows = connectors.filter((c) => !declaredSet.has(c.connectorId));

  return (
    <div className="border border-[#d9d5cb] bg-[#fbfaf7] px-5 py-4" data-testid="connector-panel">
      {note ? <div className="mb-2 text-[12.5px] text-refuse">{note}</div> : null}
      {declared.length > 0 ? (
        <>
          <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-soft">this worker declared</div>
          <ul className="mt-1">
            {declaredRows.map((c) => (
              <ConnectorRow key={c.connectorId} c={c} declared busy={busy} onConnect={(id) => void connect(id)} onRevoke={(id) => void revoke(id)} />
            ))}
            {missingDeclared.map((id) => (
              <li key={id} className="border-b border-dashed border-[#d9d5cb] py-2.5 last:border-0" data-testid={`connector-${id}`} data-status="uncataloged">
                <span className="text-[14px] font-medium text-ink">{id}</span>
                <p className="mt-0.5 text-[12.5px] leading-snug text-warn">
                  not in the connector catalog yet — the worker plans around it, and every {id} action
                  stays simulated or held for your approval.
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {custom.length > 0 ? (
        <div className="mt-3" data-testid="byo-list">
          <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-soft">your endpoints</div>
          <ul className="mt-1">
            {custom.map((c) => (
              <li key={c.connectorId} className="border-b border-dashed border-[#d9d5cb] py-2.5 last:border-0" data-testid={`connector-${c.connectorId}`} data-status={c.status}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14px] font-medium text-ink">{c.displayName}</span>
                  <span className="font-mono text-[11.5px] text-faint">{c.custom.endpointUrl}</span>
                  <span className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-warn">byo</span>
                  {role === 'admin' ? (
                    <button
                      type="button"
                      className="ml-auto font-mono text-[12px] text-refuse hover:underline disabled:opacity-40"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Remove ${c.displayName}? Its credential is revoked and workers lose these tools immediately.`)) return;
                        setBusy(true);
                        void fetch(`/api/lab/connectors/custom/${c.connectorId}`, { method: 'DELETE' })
                          .then(() => load())
                          .finally(() => setBusy(false));
                      }}
                    >
                      remove
                    </button>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[12.5px] leading-snug text-soft">
                  {c.tools.length} tool{c.tools.length === 1 ? '' : 's'}, surface pinned at registration — every call
                  asks first until it earns autonomy. ({c.tools.map((t) => t.name).slice(0, 6).join(', ')}{c.tools.length > 6 ? ', …' : ''})
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {role === 'admin' ? <ByoEndpointForm onRegistered={() => void load()} /> : null}
      {catalogRows.length > 0 ? (
        <details className={declared.length > 0 ? 'mt-3' : ''}>
          <summary className="cursor-pointer font-mono text-[12px] uppercase tracking-[0.13em] text-faint hover:text-accent">
            full connector catalog · {catalogRows.length}
          </summary>
          <ul className="mt-1">
            {catalogRows.map((c) => (
              <ConnectorRow key={c.connectorId} c={c} declared={false} busy={busy} onConnect={(id) => void connect(id)} onRevoke={(id) => void revoke(id)} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
