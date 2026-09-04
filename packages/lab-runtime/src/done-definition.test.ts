// THE DONE-DEFINITION LAW (2026-09-03): a task whose done-definition names
// a deliverable file the run does not hold is NOT complete — even when the
// stop text names nothing at all, which is exactly the hollow mid-thought
// case the file-claims law cannot see (run-8a3ec460; it cost two of four
// draft attempts in the F4 rehearsal).
import { describe, expect, it } from 'vitest';
import { DONE_FILE_REPAIR_PREFIX, doneFileRepairMessage, missingClaimedFiles } from './loop.js';

describe('the done-definition law', () => {
  it('reads the done-definition as a standing file claim', () => {
    const done = 'verdict.json is in the run files as one strict JSON object with keys verdict, checks and requiredChanges.';
    expect(missingClaimedFiles(done, [])).toEqual(['verdict.json']);
    expect(missingClaimedFiles(done, ['verdict.json'])).toEqual([]);
    expect(missingClaimedFiles(done, ['facts.json', 'draft.json'])).toEqual(['verdict.json']);
  });

  it('the hollow mid-thought stop names nothing — which is why the report-side law misses it', () => {
    // run-8a3ec460's actual final text.
    const hollow = 'Good, the files are in the Python CWD. Now let me read both fully.';
    expect(missingClaimedFiles(hollow, [])).toEqual([]);
    // …while the mission's own done-definition still indicts it.
    expect(missingClaimedFiles('verdict.json is in the run files', [])).toEqual(['verdict.json']);
  });

  it('a done-definition naming no file indicts nothing (standing missions and prose deliverables)', () => {
    expect(missingClaimedFiles('the summary states the three main findings', [])).toEqual([]);
    expect(missingClaimedFiles('the operator has been notified and the brief is filed', [])).toEqual([]);
  });

  it('the repair names the missing files and forbids the mid-thought stop', () => {
    const m = doneFileRepairMessage(['verdict.json', 'chart.png']);
    expect(m.role).toBe('user');
    expect(m.content).toContain(DONE_FILE_REPAIR_PREFIX);
    expect(m.content).toContain('verdict.json, chart.png');
    expect(m.content).toMatch(/never stop mid-thought/);
  });

  it('multi-file done-definitions indict only what is actually missing', () => {
    const done = 'the xlsx and chart are in the run files: orders-analysis.xlsx and daily-orders-chart.png, plus three-line-summary.txt';
    expect(missingClaimedFiles(done, ['orders-analysis.xlsx'])).toEqual(['daily-orders-chart.png', 'three-line-summary.txt']);
    expect(missingClaimedFiles(done, ['deliverables/orders-analysis.xlsx', 'daily-orders-chart.png', 'three-line-summary.txt'])).toEqual([]);
  });
});
