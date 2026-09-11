// The author page promised readers that "every correction will be listed
// here, permanently" next to a HARDCODED "no corrections on record" — a
// sentence that would have gone on saying that through any number of them.
// The first real correction (2026-09-10: an item count published as a model
// count) made the promise false rather than merely decorative.
//
// These tests pin the property that makes it true again: corrections are
// DERIVED from the published corpus, so an author cannot have a clean record
// because nobody wrote one down — only because the corpus holds none.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
const prev = process.env.FRONTIER_NOTES_DIR;

const issue = (over: Record<string, unknown>) => ({
  slug: 'x', week: 'x', title: 'T', summary: '', publishedAt: '2026-09-10T00:00:00Z',
  byline: 'Delta', plain: '', lede: '', frontierNote: '', auditionNote: '', mixingNote: '',
  takeaway: '', method: '', faq: [], facts: null, status: 'published', writer: null,
  ...over,
});

const write = (name: string, o: Record<string, unknown>) =>
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(o));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notes-'));
  process.env.FRONTIER_NOTES_DIR = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prev === undefined) delete process.env.FRONTIER_NOTES_DIR;
  else process.env.FRONTIER_NOTES_DIR = prev;
});

describe('corrections are derived from the corpus, never asserted', () => {
  it('an author with no corrections in the corpus has none', async () => {
    write('a', issue({ slug: 'a', week: '2026-09-09' }));
    const { correctionsForByline } = await import('@/lib/research');
    expect(correctionsForByline('Delta')).toEqual([]);
  });

  it('surfaces a correction, and carries the issue it belongs to', async () => {
    write('a', issue({
      slug: '2026-09-10', week: '2026-09-10', title: 'The summarization note',
      corrections: [{ at: '2026-09-11T02:47:36Z', was: 'Eighteen models', now: 'Four models', why: 'items counted as models' }],
    }));
    const { correctionsForByline } = await import('@/lib/research');
    const got = correctionsForByline('Delta');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ was: 'Eighteen models', now: 'Four models', slug: '2026-09-10', title: 'The summarization note' });
  });

  it('newest first, across issues — a record reads as a history', async () => {
    write('a', issue({ slug: 'a', week: '2026-09-08', corrections: [{ at: '2026-09-08T00:00:00Z', was: 'x', now: 'y' }] }));
    write('b', issue({ slug: 'b', week: '2026-09-10', corrections: [{ at: '2026-09-11T00:00:00Z', was: 'p', now: 'q' }] }));
    const { correctionsForByline } = await import('@/lib/research');
    expect(correctionsForByline('Delta').map((c) => c.was)).toEqual(['p', 'x']);
  });

  it('another author does not inherit them, and the match ignores case and padding', async () => {
    write('a', issue({ slug: 'a', week: '2026-09-10', byline: '  delta  ', corrections: [{ at: '2026-09-11T00:00:00Z', was: 'x', now: 'y' }] }));
    const { correctionsForByline } = await import('@/lib/research');
    expect(correctionsForByline('Delta')).toHaveLength(1);
    expect(correctionsForByline('Auditor')).toEqual([]);
  });

  it('a HELD issue contributes nothing — unpublished prose has no public record to correct', async () => {
    write('a', issue({ slug: 'a', week: '2026-09-10', status: 'held', corrections: [{ at: '2026-09-11T00:00:00Z', was: 'x', now: 'y' }] }));
    const { correctionsForByline } = await import('@/lib/research');
    expect(correctionsForByline('Delta')).toEqual([]);
  });
});
