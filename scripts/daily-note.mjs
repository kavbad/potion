// FRONTIER NOTES · the daily note (Answer Engine C3, 2026-08-25).
//
// Publishes a SHORT issue on any day the measured truth actually changed —
// and stays silent otherwise. Formulaic daily filler is precisely what the
// 2026 scaled-content enforcement punishes, so the rule is structural:
// no event, no post.
//
// The composer consumes Potion's OWN public answers API, so masking
// (embargoed models, combinations), live-only filtering, and honest
// rounding are all inherited — this script cannot leak what the API
// already refuses to say. The redaction gate still runs over the composed
// text as the belt.
//
// Runs from cron via the observatory service (rw /research mount):
//   docker compose ... run --rm -v /opt/potion/app/scripts:/app/scripts:ro \
//     observatory node /app/scripts/daily-note.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.POTION_PUBLIC_API ?? 'https://api.withpotion.com';
const NOTES_DIR = process.env.DAILY_NOTES_DIR ?? '/research/artifacts/notes';
const STATE_PATH = join(NOTES_DIR, '.daily-state.json');

const money = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Pure composer: prior state + the public payload → { note, state } | null.
 *  Exported for tests; main() below does the IO. */
export function composeDailyNote(prev, payload, dateIso) {
  const day = dateIso.slice(0, 10);
  const events = [];
  const clusters = new Map((prev?.clusters ?? []).map((c) => [c.clusterId, c.version]));
  for (const c of payload.clusters) {
    const before = clusters.get(c.clusterId);
    if (before !== undefined && before !== c.version) {
      const top = c.points.reduce((m, p) => Math.max(m, p.quality), 0);
      const qualifying = c.points.filter((p) => p.quality >= top * 0.9);
      const cheapest = qualifying.reduce((b, p) => (b === null || p.costPer1K < b.costPer1K ? p : b), null);
      events.push({
        kind: 'frontier-moved',
        clusterId: c.clusterId,
        text:
          `The ${c.name.toLowerCase()} frontier moved to v${c.version} today: ${c.points.length} options now sit on the ` +
          `measured line, top quality ${top.toFixed(3)}, and the cheapest option within 90% of the top is ` +
          `${cheapest.masked ? "Potion's routed pick (name withheld)" : cheapest.label} at ${money(cheapest.costPer1K)} per 1,000 requests.`,
      });
    }
  }
  if (prev?.pricesVersion !== undefined && prev.pricesVersion !== payload.pricesVersion) {
    events.push({
      kind: 'prices-updated',
      text:
        `The price table moved to ${payload.pricesVersion} today; measured cost per 1,000 requests on every ` +
        `answers page reflects the new prices.`,
    });
  }
  const state = {
    clusters: payload.clusters.map((c) => ({ clusterId: c.clusterId, version: c.version })),
    pricesVersion: payload.pricesVersion,
    lastRun: dateIso,
  };
  if (events.length === 0 || prev === null) return { note: null, state }; // first run only records state
  const moved = events.filter((e) => e.kind === 'frontier-moved');
  const title =
    moved.length === 1
      ? `Daily note: the ${moved[0].clusterId} frontier moved`
      : moved.length > 1
        ? `Daily note: ${moved.length} frontiers moved`
        : 'Daily note: prices moved';
  const body = events.map((e) => e.text).join('\n\n');
  const note = {
    kind: 'daily',
    slug: `${day}-daily`,
    week: day,
    title,
    summary: events[0].text,
    publishedAt: dateIso,
    byline: 'Potion Research · the measurement engine',
    body,
    plain:
      'A short note published only on days the measured truth changed. The full picture is always on the answers pages; the weekly issue carries the analysis.',
    status: 'published',
    writer: null,
    facts: null,
  };
  return { note, state };
}

async function main() {
  const res = await fetch(`${API}/api/public/answers`);
  if (!res.ok) throw new Error(`public answers HTTP ${res.status}`);
  const payload = await res.json();
  const prev = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null;
  const { note, state } = composeDailyNote(prev, payload, new Date().toISOString());
  mkdirSync(NOTES_DIR, { recursive: true });
  if (note) {
    // The belt: the same publication gate every weekly issue passes.
    const { assertPublishable } = await import('file:///app/node_modules/@potion/workers/dist/index.js');
    assertPublishable([note.title, note.summary, note.body, note.plain].join('\n'));
    const out = join(NOTES_DIR, `${note.slug}.json`);
    if (existsSync(out)) {
      console.log(`daily note for ${note.week} already exists — not overwriting`);
    } else {
      writeFileSync(out, JSON.stringify(note, null, 1));
      console.log(`published ${note.slug}: ${note.title}`);
    }
  } else {
    console.log(prev === null ? 'first run: state recorded, nothing published' : 'no measured change today — nothing published');
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  main().catch((e) => {
    console.error('daily-note failed:', e.message);
    process.exit(1);
  });
}
