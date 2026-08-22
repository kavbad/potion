import { describe, expect, it } from 'vitest';
import { assertPublishable, findLeaks } from './redact.js';

describe('frontier-notes redaction', () => {
  it('passes a clean draft unchanged', () => {
    const t = 'On classification, or-deepseek-v4-flash-0731 measured 0.988 ± 0.012 at $0.0201 per 1,000 requests.';
    expect(findLeaks(t)).toEqual([]);
    expect(assertPublishable(t)).toBe(t);
  });

  it('catches every spelling of a withheld name', () => {
    for (const s of ['solar-pro4', 'Solar Pro 4', 'solar_pro4', 'SolarPro4', 'or-solar-pro4', 'Upstage', 'UPSTAGE’s model']) {
      expect(findLeaks(`the winner was ${s} again`).length, s).toBeGreaterThan(0);
    }
  });

  it('does not false-positive on public names that share letters', () => {
    expect(findLeaks('or-sonnet, or-gpt-mini, solar panels are unrelated, upstream latency rose')).toEqual([]);
  });

  it('catches mechanism detail: names, thresholds, hashes, recipes', () => {
    expect(findLeaks('we used consensus-or-escalate').some((h) => h.why === 'mechanism name')).toBe(true);
    expect(findLeaks('if confidence is below 0.62 we escalate').some((h) => h.why === 'gate threshold')).toBe(true);
    expect(findLeaks('strategy 1fd419ee3f167ee3436d46359f7e0fd179ebdace11394a6acd6ca686e3852936').some((h) => h.why === 'strategy hash')).toBe(true);
    expect(findLeaks('runs or-gpt-mini then escalates to or-sonnet').some((h) => h.why === 'mixture recipe')).toBe(true);
  });

  it('fails closed with every hit named', () => {
    expect(() => assertPublishable('Upstage wins; we use vote3 with a judge model.')).toThrow(/3 leak\(s\)/);
  });

  it('accepts operator additions to the never-name list', () => {
    expect(findLeaks('acme-9b is the pick', ['acme-9b']).length).toBe(1);
  });
});
