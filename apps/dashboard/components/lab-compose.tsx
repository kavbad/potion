'use client';
// THE COMPOSE BOX (2026-09-03, operator: "a single prompt box, everything
// else auto-filled") — hiring a worker is now ONE field.
//
// What the old form asked in fourteen controls, this asks in one sentence
// and derives:
//   · kind        — standing vs one-off, from the job's own language
//   · accounts    — the connectors the job names, matched to the catalog
//   · budget      — the default cap; advanced changes it
//   · everything else (name, done-definition, quality bar, rules) — DRAFTED
//     BY THE BUILD from the job text, which is what generate already did
//     for blank fields. Nothing here is invented client-side: an unstated
//     field is drafted by the same path that always drafted it.
//
// The premade species live IN the prompt area as examples: one click loads
// that species' authored job text AND its cluster, so an example hire never
// gets quizzed about what kind of work it is.
//
// Advanced settings are one click away and are the SAME InterviewForm as
// before — no second implementation of the hire path, no drift.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GALLERY } from './lab-gallery';
import { detectAccounts, InterviewForm, STANDING_HINT } from './lab-actions';

/** The examples worth putting in front of someone on their first visit —
 * one per shape of work, in the order a new operator recognizes them. */
const FEATURED = ['data-analyst', 'pricing-watchdog', 'code-reviewer', 'research-summarizer', 'competitor-tracker', 'codebase-surgeon'];

interface GenerateResult {
  kind?: 'complete' | 'draft' | 'refused';
  harnessHash?: string;
  name?: string;
  gaps?: Array<{ code: string; question?: string; candidates?: string[] }>;
  error?: { message?: string };
}

export function LabCompose() {
  const router = useRouter();
  const [goal, setGoal] = useState('');
  const [species, setSpecies] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Array<{ connectorId: string; displayName: string }>>([]);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    fetch('/api/lab/connectors', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const list = (b as { connectors?: Array<{ connectorId: string; displayName: string }> } | null)?.connectors;
        if (list) setCatalog(list.map((c) => ({ connectorId: c.connectorId, displayName: c.displayName })));
      })
      .catch(() => null);
  }, []);

  const examples = useMemo(
    () => FEATURED.map((id) => GALLERY.find((g) => g.id === id)).filter((g): g is (typeof GALLERY)[number] => g !== undefined),
    [],
  );

  const hire = useCallback(
    async (clusterChoice?: string) => {
      const job = goal.trim();
      if (job === '') return;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const cluster =
          clusterChoice ?? (species !== null ? GALLERY.find((g) => g.id === species)?.prefill.clusterId : undefined);
        const res = await fetch('/api/lab/harnesses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            answers: {
              goal: job,
              // Derived, not asked: the job's own language says whether this
              // is a standing responsibility or a one-off piece of work.
              kind: STANDING_HINT.test(job) ? 'standing' : 'task',
              accounts: detectAccounts(job, catalog),
              worthUsd: 1,
              whenUnsure: 'ask-first',
              ...(cluster !== undefined ? { clusterChoice: cluster } : {}),
            },
          }),
        });
        const body = (await res.json().catch(() => null)) as GenerateResult | null;
        if (res.status === 201 && body?.harnessHash) {
          router.push(`/lab/worker/${body.harnessHash}?born=1`);
          return;
        }
        if (body?.gaps !== undefined) setResult(body);
        else setError(body?.error?.message ?? `could not build the worker (${res.status})`);
      } catch {
        setError('the Potion API is unreachable.');
      } finally {
        setBusy(false);
      }
    },
    [goal, species, catalog, router],
  );

  /** Advanced opens the full form, carrying what has been typed so far —
   * the same prefill channel the gallery has always used. The payload is
   * STAGED, not dispatched here: the form mounts on this same click, and a
   * dispatch before its listener exists lands in the void (seen live —
   * advanced opened with an empty job). The effect below fires after the
   * child's mount effect, which is exactly when the listener is live. */
  const [pendingPrefill, setPendingPrefill] = useState<Record<string, unknown> | null>(null);
  const openAdvanced = useCallback(() => {
    const g = species !== null ? GALLERY.find((x) => x.id === species) : undefined;
    setPendingPrefill(
      g !== undefined
        ? { ...g.prefill, goal: goal.trim() === '' ? g.prefill.goal : goal }
        : {
            goal,
            kind: STANDING_HINT.test(goal) ? 'standing' : 'task',
            accounts: detectAccounts(goal, catalog).join(', '),
            worth: '1',
            qualityBar: '',
            produces: '',
            never: '',
            whenUnsure: 'ask-first',
          },
    );
    setAdvanced(true);
  }, [goal, species, catalog]);

  useEffect(() => {
    if (!advanced || pendingPrefill === null) return;
    window.dispatchEvent(new CustomEvent('potion:hire-prefill', { detail: pendingPrefill }));
    setPendingPrefill(null);
  }, [advanced, pendingPrefill]);

  const clusterGap = result?.gaps?.find((g) => g.code === 'cluster-uncertain');
  const evidenceGaps = (result?.gaps ?? []).filter((g) => g.code !== 'cluster-uncertain');

  return (
    <div data-testid="lab-compose">
      <div
        className={`relative border bg-white transition-colors ${
          busy ? 'border-accent/60' : 'border-[#c4bfb2] focus-within:border-accent'
        }`}
      >
        {/* THE SIZER (2026-09-03): an invisible copy of the text shares this
            grid cell with the textarea, so the BOX grows with the job by
            layout alone. Measuring scrollHeight raced the render and left an
            empty box 420px tall — a wall of white on the first screen. */}
        <div className="grid max-h-[420px] overflow-y-auto px-5 pt-5 text-[16px] leading-relaxed">
          <div
            aria-hidden
            className="invisible col-start-1 row-start-1 min-h-[4.9rem] whitespace-pre-wrap break-words"
          >
            {goal === '' ? ' ' : `${goal} `}
          </div>
          <textarea
            ref={boxRef}
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              if (species !== null) setSpecies(null);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void hire();
            }}
            disabled={busy}
            placeholder="Describe the job, like you would to a new hire. Potion builds the worker around it."
            className="col-start-1 row-start-1 block w-full resize-none overflow-hidden bg-transparent text-ink outline-none placeholder:text-faint disabled:opacity-60"
            data-testid="compose-goal"
          />
        </div>
        <div className="flex items-center justify-between gap-4 px-5 pb-4 pt-2">
          <button
            type="button"
            onClick={openAdvanced}
            className="font-mono text-[12px] text-faint underline decoration-line underline-offset-4 hover:text-accent"
            data-testid="compose-advanced"
          >
            advanced settings
          </button>
          <button
            type="button"
            onClick={() => void hire()}
            disabled={busy || goal.trim() === ''}
            className="bg-ink px-5 py-2 text-[13.5px] font-semibold text-[#f4f2ec] transition-opacity hover:opacity-90 disabled:opacity-25"
            data-testid="compose-hire"
          >
            {busy ? 'Building…' : 'Hire worker'}
          </button>
        </div>
      </div>

      {/* The premade species AS the prompt area's examples — one click loads
          the species' own job text and its authored cluster. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="font-mono text-[12px] text-faint">try</span>
        {examples.map((g) => (
          <button
            key={g.id}
            type="button"
            disabled={busy}
            onClick={() => {
              setGoal(g.prefill.goal);
              setSpecies(g.id);
              setResult(null);
              requestAnimationFrame(() => boxRef.current?.focus());
            }}
            className={`border px-2.5 py-1 font-mono text-[12px] transition-colors disabled:opacity-40 ${
              species === g.id
                ? 'border-accent text-accent'
                : 'border-line text-soft hover:border-[#c4bfb2] hover:text-ink'
            }`}
            data-testid={`compose-example-${g.id}`}
          >
            {g.name}
          </button>
        ))}
      </div>

      <p className="mt-3 font-mono text-[12px] leading-relaxed text-faint">
        born supervised · hard budget · it asks before every external action
      </p>

      {error !== null ? (
        <p className="mt-4 border border-refuse px-4 py-3 text-[13.5px] text-refuse" data-testid="compose-error">
          {error}
        </p>
      ) : null}

      {/* One question, only when the build genuinely cannot tell. */}
      {clusterGap !== undefined ? (
        <div className="mt-4 border border-accent/40 bg-white px-4 py-3.5" data-testid="compose-cluster-gap">
          <p className="text-[14px] leading-relaxed text-ink">
            What kind of work is this closest to? It decides which measured evidence the worker&rsquo;s
            brain is chosen from.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {(clusterGap.candidates ?? []).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => void hire(c)}
                disabled={busy}
                className="border border-[#c4bfb2] bg-[#fbfaf7] px-3.5 py-2 font-mono text-[13px] text-ink hover:border-accent hover:text-accent disabled:opacity-40"
                data-testid={`compose-cluster-${c}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* An honest stop: no live evidence for this kind of work yet. */}
      {evidenceGaps.length > 0 ? (
        <div className="mt-4 border border-[#c4bfb2] bg-white px-4 py-3.5" data-testid="compose-evidence-gap">
          <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-warn">an honest stop</span>
          <p className="mt-1.5 text-[14px] leading-relaxed text-soft">
            A worker is only ever born on live, measured evidence — and Potion doesn&rsquo;t have it for
            this kind of work yet, so it refuses to build on guesses.
          </p>
          <ul className="mt-2 list-disc pl-5 font-mono text-[12.5px] text-faint">
            {evidenceGaps.map((g, i) => (
              <li key={i}>{g.question ?? g.code}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The full control set — the same form as before, nothing forked. */}
      {advanced ? (
        <div className="mt-8 border-t border-line pt-6" data-testid="compose-advanced-panel">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[12px] uppercase tracking-[0.13em] text-faint">
              advanced · every field, by hand
            </span>
            <button
              type="button"
              onClick={() => setAdvanced(false)}
              className="font-mono text-[12px] text-faint hover:text-accent"
            >
              hide
            </button>
          </div>
          <InterviewForm />
        </div>
      ) : null}
    </div>
  );
}
