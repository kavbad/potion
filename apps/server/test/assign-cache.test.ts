// P0-2: the assignment cache is bounded now.
import { describe, expect, it } from 'vitest';
import { AssignCache, ASSIGN_CACHE_MAX_ENTRIES } from '../src/assign-cache.js';

describe('the cache holds at its cap', () => {
  it('THE SOAK: N distinct prompts leave it at the cap, not at N', () => {
    const c = new AssignCache<number>(100);
    for (let i = 0; i < 25_000; i++) c.set(`prompt-${i}`, i);
    expect(c.size).toBe(100);
    expect(c.stats().evictions).toBe(24_900);
  });

  it('evicts the least recently USED, not the least recently written', () => {
    const c = new AssignCache<number>(3);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    expect(c.get('a')).toBe(1);       // 'a' is now the most recent
    c.set('d', 4);                     // evicts 'b', the true LRU
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
  });

  it('expires on age, because a ranking is a decision against centroids that move', () => {
    let clock = 0;
    const c = new AssignCache<number>(10, 1000, () => clock);
    c.set('a', 1);
    clock = 999;
    expect(c.get('a')).toBe(1);
    clock = 1000;
    expect(c.get('a')).toBeUndefined();
    expect(c.stats().expiries).toBe(1);
    expect(c.size).toBe(0);            // and it is gone, not merely hidden
  });

  it('counts hits, misses and evictions — a rate rebuilt from logs cannot see an eviction', () => {
    const c = new AssignCache<number>(2);
    c.set('a', 1); c.set('b', 2);
    c.get('a'); c.get('a'); c.get('zzz');
    c.set('c', 3);
    const s = c.stats();
    expect(s).toMatchObject({ entries: 2, hits: 2, misses: 1, evictions: 1, maxEntries: 2 });
  });

  it('re-setting a key does not grow it', () => {
    const c = new AssignCache<number>(10);
    for (let i = 0; i < 500; i++) c.set('same', i);
    expect(c.size).toBe(1);
    expect(c.get('same')).toBe(499);
  });

  it('the default cap is a real number, not Infinity', () => {
    expect(ASSIGN_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(Number.isFinite(ASSIGN_CACHE_MAX_ENTRIES)).toBe(true);
  });
});
