// Observatory report sink: Notion. One entry per weekly run, appended to a
// page the operator connected to the "Potion Observatory" integration.
// Pure block-building is separate from the HTTP call so the shape is
// testable; posting is best-effort and NEVER fails the run — the ledger and
// the run record on disk are the system of record, Notion is the reading room.
import type { ObservatoryRun } from './observatory.js';
import { digestLine } from './observatory.js';

type RichText = { type: 'text'; text: { content: string } };
const rt = (content: string): RichText[] => [{ type: 'text', text: { content: content.slice(0, 1900) } }];

export function observatoryEntryBlocks(run: ObservatoryRun): unknown[] {
  const blocks: unknown[] = [
    { object: 'block', type: 'heading_2', heading_2: { rich_text: rt(`${run.week} — ${run.at.slice(0, 10)}`) } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: rt(digestLine(run)) } },
  ];
  const bullet = (text: string) => ({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(text) } });
  for (const n of run.plan.notes) blocks.push(bullet(`note: ${n}`));
  if (run.canaries.length > 0) {
    blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt('Canaries (drift sentinels)') } });
    for (const c of run.canaries) {
      const obs = c.observedMean === null ? '—' : c.observedMean.toFixed(3);
      blocks.push(bullet(`${c.clusterId} · ${c.model}: observed ${obs} on ${c.n} items vs stored ${c.storedQuality.toFixed(3)} ±${c.storedCi95.toFixed(3)} → ${c.verdict.toUpperCase()}${c.error ? ` (${c.error.slice(0, 120)})` : ''} · $${c.spendUsd.toFixed(4)}`));
    }
  }
  blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt('Auditions (new-model tryouts)') } });
  blocks.push(bullet(`catalogue: ${run.catalogue.listings} listings, ${run.catalogue.newSinceRegistry} not yet in the registry, ${run.catalogue.freeTierExcluded} free-tier excluded, ${run.catalogue.ranked} ranked`));
  if (run.auditions.length === 0) blocks.push(bullet('no auditions ran this week'));
  for (const a of run.auditions) {
    const outcome = a.error ? `ERROR ${a.error.slice(0, 120)}` : a.earnedSlot ? `EARNED A SLOT (frontier v${a.frontierVersion})` : 'did not earn a slot';
    blocks.push(bullet(`${a.alias} on ${a.clusterId} (${a.lane}; ${a.why}) → ${outcome} · $${a.spendUsd.toFixed(4)}`));
  }
  blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(`Spend this run $${run.spendUsd.toFixed(2)} · month-to-date $${run.envelopeAfter.mtdUsd.toFixed(2)} of $${run.envelopeAfter.capUsd} envelope`) } });
  return blocks;
}

/** Append the entry to the page. Returns a short status string; never throws. */
export async function postObservatoryEntry(
  opts: { token: string; pageId: string; fetchImpl?: typeof fetch },
  run: ObservatoryRun,
): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`https://api.notion.com/v1/blocks/${opts.pageId}/children`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ children: observatoryEntryBlocks(run) }),
    });
    if (!res.ok) return `notion: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`;
    return 'notion: posted';
  } catch (e) {
    return `notion: ${e instanceof Error ? e.message : String(e)}`;
  }
}
