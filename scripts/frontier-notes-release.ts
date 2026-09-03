// F2 (docs/RESEARCH-FLEET.md R3) — release a gate-held Frontier Notes
// issue AFTER the operator resolved the publish question. The content is
// frozen: the approval bound to the held draft's fingerprint, so this
// script re-checks the SAME hash — it never re-drafts. A changed file, a
// missing resolution, or a denial leaves the issue held.
//
//   NOTES_DIR=<dir> WEEK=2026-W37 \
//   POTION_LAB_URL=https://api.withpotion.com \
//   POTION_RESEARCH_KEY=pk_... POTION_LAB_SESSION=ps_... \
//   DELTA_HARNESS=<hash> npx tsx scripts/frontier-notes-release.ts
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { publishActionId, publishArgsHash, publishGateDecision, reportPublishOutcome, writeIssue, type Issue } from '@potion/workers';

/** The dashboard run route cannot serve runx- gate sessions yet, so the
 * operator's fingerprint-bound answer is read from the durable record
 * (lab_run_steps) when DATABASE_URL is provided. */
async function resolutionFromRecord(runId: string, actionId: string): Promise<'approved' | 'rejected' | null> {
  const url = process.env.DATABASE_URL;
  if (!url || !runId) return null;
  const require_ = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const pg = require_('pg') as typeof import('pg');
  const c = new pg.Client({ connectionString: url, ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT payload->>'checkInAnswer' AS a FROM lab_run_steps WHERE run_id = $1 AND payload->>'checkInAnswer' LIKE '%[action ' || $2 || ']%' ORDER BY seq DESC LIMIT 1`,
      [runId, actionId],
    );
    const a = (r.rows[0]?.a as string | undefined) ?? '';
    if (a.startsWith('approved')) return 'approved';
    if (a.includes('rejected')) return 'rejected';
    return null;
  } finally {
    await c.end();
  }
}

const NOTES_DIR = process.env.NOTES_DIR;
const WEEK = process.env.WEEK;
const KEY = process.env.POTION_RESEARCH_KEY;
const HARNESS = process.env.DELTA_HARNESS;
if (!NOTES_DIR || !WEEK || !KEY || !HARNESS) throw new Error('set NOTES_DIR, WEEK, POTION_RESEARCH_KEY, DELTA_HARNESS');

const path = `${NOTES_DIR}/${WEEK}.json`;
const issue = JSON.parse(readFileSync(path, 'utf8')) as Issue;
if (issue.status !== 'held' || !issue.publishGate) {
  console.log(`${WEEK} is ${issue.status}${issue.publishGate ? '' : ' (no publish gate on record)'} — nothing to release`);
  process.exit(0);
}

const draft = {
  title: issue.title,
  summary: issue.summary,
  plain: issue.plain,
  lede: issue.lede,
  frontierNote: issue.frontierNote,
  auditionNote: issue.auditionNote,
  mixingNote: issue.mixingNote,
  takeaway: issue.takeaway,
  faq: issue.faq,
};
const hash = publishArgsHash(issue.week, draft);
if (hash !== issue.publishGate.argsHash) {
  throw new Error(`content changed since the gate held it (${hash.slice(0, 8)} != ${issue.publishGate.argsHash.slice(0, 8)}) — the approval does not cover this file`);
}

const recorded = await resolutionFromRecord(issue.publishGate.runId, publishActionId(issue.week, hash));
const gate = {
  url: process.env.POTION_LAB_URL ?? 'https://api.withpotion.com',
  apiKey: KEY,
  harnessHash: HARNESS,
  ...(process.env.POTION_LAB_SESSION ? { session: process.env.POTION_LAB_SESSION } : {}),
  ...(recorded !== null ? { priorResolution: recorded } : {}),
};
const g = await publishGateDecision(issue.week, draft, gate);
if (g.decision !== 'allow') {
  console.log(`still ${g.decision}: ${g.question ?? g.error ?? 'awaiting operator'} — gate session ${g.runId}`);
  process.exit(2);
}

const { heldReason: _dropped, ...rest } = issue;
const released: Issue = {
  ...rest,
  status: 'published',
  publishGate: {
    decision: 'allow',
    runId: g.runId,
    actionId: g.actionId,
    argsHash: g.argsHash,
    ...(g.audit !== undefined ? { audit: g.audit } : {}),
    ...(g.priorResolution !== undefined ? { priorResolution: g.priorResolution } : {}),
  },
};
const files = writeIssue(NOTES_DIR, released);
await reportPublishOutcome(released.publishGate!, true, gate);
console.log(`RELEASED ${issue.week}: "${issue.title}"${g.priorResolution ? ' (operator allow-once)' : ''}${g.audit ? ' · audit sampled' : ''}`);
console.log(`${files.json}\n${files.md}`);
