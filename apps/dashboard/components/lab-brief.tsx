// The deliverable, rendered FIRST (P1, "the mouth"). The brief is the
// product of a check — the narration and accounting sit beneath it. Every
// headline claim renders with its source link because the contract put it
// there; nothing here invents structure the record doesn't carry.
import type { Brief } from '@potion/lab-spec';

const EYEBROW = 'font-mono text-[12px] uppercase tracking-[0.13em] text-faint';

export function BriefView({ brief, title }: { brief: Brief; title?: string }) {
  return (
    <div className="border border-accent/40 bg-[#fbfaf7] px-6 py-5" data-testid="brief-view">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-mono text-[12px] uppercase tracking-[0.13em] text-accent">
          {title ?? 'the brief — this check’s deliverable'}
        </div>
        <span className={EYEBROW}>
          {brief.coverage.checked} source{brief.coverage.checked === 1 ? '' : 's'} checked
        </span>
      </div>

      {brief.headline.length > 0 ? (
        <ol className="mt-3 grid gap-2.5">
          {brief.headline.map((h2, i) => (
            <li key={i} className="flex items-baseline gap-3">
              <span className="shrink-0 font-mono text-[12px] uppercase tracking-[0.1em] text-accent">act now</span>
              <span className="text-[15px] leading-snug text-ink">
                {h2.claim}
                {' '}
                <a href={h2.sourceUrl} target="_blank" rel="noreferrer" className="whitespace-nowrap font-mono text-[12px] text-soft underline hover:text-accent">
                  source ↗
                </a>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-[14px] text-soft" data-testid="brief-quiet-day">
          Nothing act-now today — stated, not implied.
        </p>
      )}

      {brief.byEntity.length > 0 ? (
        <div className="mt-4 border-t border-dashed border-[#d9d5cb] pt-3">
          <div className={EYEBROW}>by company</div>
          <dl className="mt-2 grid gap-2">
            {brief.byEntity.map((e) => (
              <div key={e.entity} className="flex flex-wrap items-baseline gap-x-3">
                <dt className="w-36 shrink-0 truncate text-[13.5px] font-medium text-ink">{e.entity}</dt>
                <dd className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-soft">
                  {e.items.map((it, i) => (
                    <span key={i}>
                      {it.note}
                      {it.sourceUrl !== undefined ? (
                        <>
                          {' '}
                          <a href={it.sourceUrl} target="_blank" rel="noreferrer" className="font-mono text-[11.5px] text-faint underline hover:text-accent">↗</a>
                        </>
                      ) : null}
                      {i < e.items.length - 1 ? ' · ' : ''}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {(brief.quiet.length > 0 || brief.coverage.note !== undefined) ? (
        <p className="mt-3 border-t border-dashed border-[#d9d5cb] pt-2.5 font-mono text-[12px] leading-relaxed text-faint">
          {brief.quiet.length > 0 ? <>quiet: {brief.quiet.join(', ')}</> : null}
          {brief.quiet.length > 0 && brief.coverage.note !== undefined ? ' · ' : ''}
          {brief.coverage.note !== undefined ? <span className="text-warn">{brief.coverage.note}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
