// THE NARRATOR laws (2026-09-01): never raw JSON as a headline, never an
// empty labeled row, truncation at word boundaries with the record named.
import { describe, expect, it } from 'vitest';
import { clip, narrateStep } from './narrate.js';

describe('no-information rows vanish', () => {
  it('a tool-calling model step with no prose is hidden', () => {
    expect(narrateStep({ kind: 'model', responseText: '', toolCalls: [{ id: 't1' }] }).hidden).toBe(true);
  });
  it('an empty model step is hidden; a real thought shows', () => {
    expect(narrateStep({ kind: 'model', responseText: '' }).hidden).toBe(true);
    const n = narrateStep({ kind: 'model', responseText: 'I will read the file first.' });
    expect(n.hidden).toBeUndefined();
    expect(n.detail).toContain('read the file');
  });
});

describe('tools speak human', () => {
  it('remember never dumps JSON', () => {
    const n = narrateStep({
      kind: 'tool', toolName: 'remember',
      toolOutput: { ok: true, newKeys: 0, _memoryWrites: { 'beat:reflections': [{ on: '2026-09-01', note: 'x' }] } },
    });
    expect(n.title).toBe('updated its working memory — 1 reflection(s)');
    expect(JSON.stringify(n)).not.toContain('_memoryWrites');
  });
  it('web_fetch names the page and clips the text at a word boundary', () => {
    const n = narrateStep({
      kind: 'tool', toolName: 'web_fetch',
      toolInput: { url: 'https://withpotion.com/home' },
      toolOutput: { text: 'word '.repeat(200) },
    });
    expect(n.title).toBe('read withpotion.com/home');
    expect(n.detail!.endsWith('… (the full record holds the rest)')).toBe(true);
    expect(n.detail!).not.toMatch(/wor …/);
  });
  it('run_python leads with the sandbox story and shows stdout as code', () => {
    const n = narrateStep({
      kind: 'tool', toolName: 'run_python',
      toolOutput: { stdout: 'total 7431.99\n', stderr: '', filesWritten: ['by-day.xlsx', 'chart.png'] },
    });
    expect(n.title).toBe('ran Python in the sandbox — wrote 2 file(s)');
    expect(n.detailKind).toBe('code');
  });
  it('an errored tool says so plainly', () => {
    const n = narrateStep({ kind: 'tool', toolName: 'browser_act', toolOutput: { error: 'the page has changed since the approval' } });
    expect(n.title).toBe('browser_act hit a problem');
    expect(n.detail).toContain('page has changed');
  });
  it('update_plan renders the ledger as checkmarks', () => {
    const n = narrateStep({
      kind: 'tool', toolName: 'update_plan',
      toolInput: { items: [{ step: 'load the file', status: 'done' }, { step: 'compute totals', status: 'active' }] },
      toolOutput: {},
    });
    expect(n.title).toBe('updated its task ledger');
    expect(n.detail).toContain('✓ load the file');
    expect(n.detail).toContain('▸ compute totals');
  });
  it('connector tools name who did what, never a raw blob', () => {
    const n = narrateStep({ kind: 'tool', toolName: 'our-crm.crm_update', toolOutput: { updated: true, id: 'x' } });
    expect(n.title).toBe('used our-crm · crm_update');
  });
});

describe('check-ins', () => {
  it('a worker question vs a permission ask read differently', () => {
    expect(narrateStep({ kind: 'check-in', checkInTrigger: 'worker-question', checkInQuestion: 'Which board?' }).title).toBe('asked you a question');
    expect(narrateStep({ kind: 'check-in', checkInTrigger: 'before-external-action', checkInQuestion: 'It wants to click X. Proceed?' }).title).toBe('asked your permission');
  });
});

describe('clip', () => {
  it('short text passes through; long text cuts at a space', () => {
    expect(clip('hello world', 50)).toBe('hello world');
    const cut = clip('alpha beta gamma delta epsilon', 14);
    expect(cut.startsWith('alpha beta')).toBe(true);
    expect(cut).toContain('the full record holds the rest');
  });
});
