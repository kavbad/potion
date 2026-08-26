// The daily-note composer (Answer Engine C3): publishes ONLY when the
// measured truth changed, inherits masking from the public payload, and
// every composed string passes the same redaction gate weekly issues pass.
import { describe, expect, it } from 'vitest';
import { findLeaks } from '@potion/workers';
// @ts-expect-error — plain .mjs script module (runs under the container's node)
import { composeDailyNote } from '../../../scripts/daily-note.mjs';

const payload = (version: number, prices = 'p1') => ({
  clusters: [
    {
      clusterId: 'classification',
      name: 'Classification',
      version,
      measuredAt: '2026-08-25T00:00:00.000Z',
      points: [
        { label: "Potion's routed pick (name withheld)", vendor: null, masked: true, kind: 'model', slug: null, quality: 0.976, costPer1K: 0.0042, latencyP95: 3489 },
        { label: 'gemini-2.5-flash', vendor: 'google', masked: false, kind: 'model', slug: 'gemini-2-5-flash', quality: 0.988, costPer1K: 0.027, latencyP95: 1080 },
      ],
    },
  ],
  pricesVersion: prices,
  generatedAt: '2026-08-26T09:00:00.000Z',
});

describe('composeDailyNote', () => {
  it('first run records state and publishes NOTHING', () => {
    const { note, state } = composeDailyNote(null, payload(5), '2026-08-26T09:00:00.000Z');
    expect(note).toBeNull();
    expect(state.clusters).toEqual([{ clusterId: 'classification', version: 5 }]);
  });

  it('no change → silence (the anti-spam rule is structural)', () => {
    const prev = composeDailyNote(null, payload(5), '2026-08-25T09:00:00.000Z').state;
    const { note } = composeDailyNote(prev, payload(5), '2026-08-26T09:00:00.000Z');
    expect(note).toBeNull();
  });

  it('a frontier move publishes a dated note that keeps the mask and passes the gate', () => {
    const prev = composeDailyNote(null, payload(5), '2026-08-25T09:00:00.000Z').state;
    const { note } = composeDailyNote(prev, payload(6), '2026-08-26T09:00:00.000Z');
    expect(note).not.toBeNull();
    expect(note!.kind).toBe('daily');
    expect(note!.week).toBe('2026-08-26');
    expect(note!.body).toContain('v6');
    expect(note!.body).toContain('name withheld'); // the cheapest qualifying is the masked pick
    expect(findLeaks([note!.title, note!.summary, note!.body, note!.plain].join('\n'))).toEqual([]);
  });

  it('a price-table move alone also publishes', () => {
    const prev = composeDailyNote(null, payload(5, 'p1'), '2026-08-25T09:00:00.000Z').state;
    const { note } = composeDailyNote(prev, payload(5, 'p2'), '2026-08-26T09:00:00.000Z');
    expect(note).not.toBeNull();
    expect(note!.title).toContain('prices moved');
  });
});
