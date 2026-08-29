'use client';
// The machinery view (2026-08-27, the operator's brief: "the user should be
// able to go deeper and see under the hood and edit down to the details —
// this is a LAB"). One object, two depths: the plain card above, this
// datasheet below. Three disciplines keep it a legit operation:
//   · CONFIG vs CONSTITUTION — every spec field is editable; the laws are
//     displayed and not editable (autonomy is earned, never typed in);
//   · every save goes through EVERY custody gate (schema, size, control
//     characters, key-shaped secrets, tamper-evident hash) and failures
//     render as the TYPED issue list — path · code · message;
//   · every save mints a NEW content-addressed version; the prior version
//     and every run frozen from it are untouched.
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HarnessDto } from '@potion/lab-form';

const MONO_LABEL = 'font-mono text-[12px] uppercase tracking-[0.13em]';

/** The laws — enforced elsewhere (schema, runtime, replay), stated here.
 * Every line is a claim a harness engineer can go verify in the machine. */
const CONSTITUTION: Array<{ law: string; where: string }> = [
  {
    law: 'The spending cap is a hard stop. A spec without one is unrepresentable — the schema requires the literal.',
    where: 'fuel.hardStop: true',
  },
  {
    law: 'Born fully supervised. Autonomy is earned per kind of action from recorded evidence — approvals, edits, rejections. Repeated-situation successes stop counting after 5; failures always count.',
    where: 'permission engine',
  },
  {
    law: 'Two identical tool-less responses in a row fail the run as stalled. A standing mission that answers with no tool call has finished its check and rests.',
    where: 'loop law',
  },
  {
    law: 'Every run is replayable from its durable trace. The replayer is held in lockstep with the runtime by golden fixtures.',
    where: 'replay',
  },
  {
    law: 'The task ledger (update_plan) rides every run: the current plan is derived from the recorded steps and re-shown at every leg boundary — a long mission cannot lose its thread.',
    where: 'ledger law',
  },
  {
    law: 'Key-shaped content anywhere in this file is a typed rejection. Credentials live in grant custody, never in a spec.',
    where: 'custody gate',
  },
  {
    law: 'Every save mints a new content-addressed version. Prior versions — and every run frozen from them — are immutable.',
    where: 'catalog invariance',
  },
];

function stripHash(specText: string): string {
  try {
    const obj = JSON.parse(specText) as Record<string, unknown>;
    delete obj['hash'];
    return JSON.stringify(obj, null, 2);
  } catch {
    return specText;
  }
}

interface SpecIssueDto {
  code: string;
  path: string;
  message: string;
}

export function LabMachinery({
  harness,
  role,
}: {
  harness: HarnessDto;
  role: 'admin' | 'member' | 'viewer';
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initialText = useMemo(() => stripHash(harness.specText ?? ''), [harness.specText]);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<SpecIssueDto[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setIssues(null);
    setNote(null);
    try {
      const res = await fetch(`/api/lab/harnesses/${harness.harnessHash}/spec`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ specText: text }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        harnessHash?: string;
        unchanged?: boolean;
        issues?: SpecIssueDto[];
        error?: { message?: string };
      };
      if (res.status === 422 && body.issues) {
        setIssues(body.issues);
      } else if (res.ok && body.unchanged) {
        setNote('No change — the file is byte-identical to the current version.');
      } else if (res.ok && body.harnessHash) {
        // A new version exists: walk to it (the old page stays true of the
        // old version, which still exists).
        router.push(`/lab/harness/${body.harnessHash}#machinery`);
      } else {
        setNote(body.error?.message ?? `save failed (${res.status})`);
      }
    } finally {
      setBusy(false);
    }
  }, [harness.harnessHash, text, router]);

  const choices = harness.sidecar.choices ?? [];
  const edited = harness.sidecar.editedFrom !== undefined || choices.length === 0;

  return (
    <section className="mt-8" id="machinery" data-testid="machinery">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`${MONO_LABEL} flex items-center gap-2 text-soft hover:text-accent`}
        data-testid="machinery-toggle"
      >
        <span className="inline-block w-3 text-center">{open ? '−' : '+'}</span>
        the machinery · the spec file, its provenance, and its laws
      </button>

      {open ? (
        <div className="mt-3 border border-[#d9d5cb] bg-[#fbfaf7]">
          {/* ---- identity ---- */}
          <div className="border-b border-[#d9d5cb] px-5 py-3.5">
            <div className={`${MONO_LABEL} text-faint`}>identity · content-addressed</div>
            <p className="mt-1.5 font-mono text-[12.5px] leading-relaxed text-ink">
              sha256 <code className="break-all">{harness.harnessHash}</code>
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-soft">
              The hash <i>is</i> the identity: it is computed from the file&rsquo;s content, recomputed
              on every parse, and a mismatch is a tamper rejection. It cannot be forged, and it changes
              whenever the worker does.
            </p>
          </div>

          {/* ---- provenance ---- */}
          <div className="border-b border-[#d9d5cb] px-5 py-3.5">
            <div className={`${MONO_LABEL} text-faint`}>provenance · how the brain was chosen</div>
            {edited ? (
              <p className="mt-1.5 text-[13px] leading-relaxed text-soft" data-testid="provenance-edited">
                <b className="text-ink">Operator-authored.</b> This version was edited by hand
                {harness.sidecar.editedFrom ? (
                  <>
                    {' '}from{' '}
                    <a href={`/lab/harness/${harness.sidecar.editedFrom}`} className="font-mono text-accent underline">
                      {harness.sidecar.editedFrom.slice(0, 12)}…
                    </a>
                  </>
                ) : null}
                . Editing a spec visibly orphans its autopilot provenance — by design, so a hand-built
                worker never wears a machine-chosen pedigree.
              </p>
            ) : (
              <div className="mt-1.5 overflow-x-auto">
                <table className="w-full font-mono text-[12px] text-ink">
                  <thead>
                    <tr className="text-left text-faint">
                      <th className="py-1 pr-4 font-normal">slot</th>
                      <th className="py-1 pr-4 font-normal">kind of work</th>
                      <th className="py-1 pr-4 font-normal">frontier</th>
                      <th className="py-1 pr-4 font-normal">strategy</th>
                      <th className="py-1 pr-4 font-normal">partition</th>
                      <th className="py-1 font-normal">alternatives</th>
                    </tr>
                  </thead>
                  <tbody>
                    {choices.map((c) => (
                      <tr key={c.slot} className="border-t border-dashed border-[#d9d5cb]">
                        <td className="py-1.5 pr-4">{c.slot}</td>
                        <td className="py-1.5 pr-4">{c.basis.clusterId}</td>
                        <td className="py-1.5 pr-4">
                          {c.basis.frontierId.slice(0, 14)}
                          {c.basis.frontierVersion !== undefined ? ` v${c.basis.frontierVersion}` : ''}
                        </td>
                        <td className="py-1.5 pr-4">{c.basis.strategyHash.slice(0, 8)}</td>
                        <td className="py-1.5 pr-4">{c.partition ?? '—'}</td>
                        <td className="py-1.5">{c.alternatives ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1.5 font-sans text-[13px] leading-relaxed text-soft">
                  Chosen from live, measured evidence — and the provenance is hash-bound to this exact
                  file: edit the file and this table visibly detaches.
                </p>
              </div>
            )}
          </div>

          {/* ---- constitution ---- */}
          <div className="border-b border-[#d9d5cb] px-5 py-3.5">
            <div className={`${MONO_LABEL} text-faint`}>laws · displayed, not editable</div>
            <ul className="mt-2 grid gap-2">
              {CONSTITUTION.map((c) => (
                <li key={c.where} className="flex items-baseline gap-3">
                  <span className="shrink-0 border border-[#c4bfb2] px-1.5 py-px font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
                    {c.where}
                  </span>
                  <span className="text-[13px] leading-relaxed text-soft">{c.law}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[13px] leading-relaxed text-soft">
              Everything <i>above</i> the laws is yours to edit. The one thing no edit can grant is
              autonomy — trust is earned from evidence, never typed into a field.
            </p>
          </div>

          {/* ---- the file ---- */}
          <div className="px-5 py-3.5">
            <div className={`${MONO_LABEL} text-faint`}>
              the file · {role === 'admin' ? 'editable — every field, schema-checked on save' : 'read-only (admin edits)'}
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              readOnly={role !== 'admin'}
              rows={Math.min(30, Math.max(14, text.split('\n').length + 2))}
              spellCheck={false}
              className="mt-2 w-full resize-y border border-[#c4bfb2] bg-white px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink focus:border-accent focus:outline-none"
              data-testid="spec-editor"
            />
            {role === 'admin' ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy}
                  className="bg-ink px-4 py-2 text-[13px] font-semibold text-[#f4f2ec] hover:opacity-90 disabled:opacity-30"
                  data-testid="spec-save"
                >
                  {busy ? 'Validating…' : 'Validate & save as a new version'}
                </button>
                <button
                  type="button"
                  onClick={() => { setText(initialText); setIssues(null); setNote(null); }}
                  disabled={busy || text === initialText}
                  className="border border-[#c4bfb2] px-3 py-2 text-[12.5px] text-soft hover:border-accent hover:text-accent disabled:opacity-30"
                >
                  Reset
                </button>
                <span className="font-mono text-[12px] text-faint">
                  this exact file is <code>GET /api/lab/harnesses/{'{hash}'}</code> — UI, JSON, and API are the same surface
                </span>
              </div>
            ) : null}
            {issues ? (
              <div className="mt-3 border border-refuse/50 bg-white px-4 py-3" data-testid="spec-issues">
                <div className={`${MONO_LABEL} text-refuse`}>refused — typed issues, nothing saved</div>
                <table className="mt-2 w-full font-mono text-[12px] text-ink">
                  <tbody>
                    {issues.map((i, n) => (
                      <tr key={n} className="border-t border-dashed border-[#d9d5cb] first:border-0">
                        <td className="py-1.5 pr-4 align-top text-refuse">{i.path || '(file)'}</td>
                        <td className="py-1.5 pr-4 align-top">{i.code}</td>
                        <td className="py-1.5 align-top font-sans text-[12.5px] text-soft">{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {note ? <p className="mt-3 text-[13px] text-soft" data-testid="spec-note">{note}</p> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
