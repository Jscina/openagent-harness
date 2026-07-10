import { describe, it, expect } from 'vitest';
import { BoundedSet, BoundedMap } from './bounded.js';

describe('BoundedSet', () => {
  it('behaves like a normal Set below capacity', () => {
    const s = new BoundedSet<string>(5);
    s.add('a');
    s.add('b');
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(true);
    expect(s.size).toBe(2);
  });

  it('evicts the oldest entry once capacity is exceeded (FIFO)', () => {
    const s = new BoundedSet<number>(3);
    s.add(1);
    s.add(2);
    s.add(3);
    expect(s.size).toBe(3);

    s.add(4); // exceeds cap of 3 → evicts 1
    expect(s.size).toBe(3);
    expect(s.has(1)).toBe(false);
    expect(s.has(2)).toBe(true);
    expect(s.has(3)).toBe(true);
    expect(s.has(4)).toBe(true);
  });

  it('never exceeds cap across many insertions', () => {
    const s = new BoundedSet<number>(10);
    for (let i = 0; i < 1000; i++) s.add(i);
    expect(s.size).toBe(10);
    // Only the most recent 10 should remain.
    for (let i = 990; i < 1000; i++) expect(s.has(i)).toBe(true);
    expect(s.has(989)).toBe(false);
  });

  it('delete removes an entry and reports whether it existed', () => {
    const s = new BoundedSet<string>(5);
    s.add('x');
    expect(s.delete('x')).toBe(true);
    expect(s.has('x')).toBe(false);
    expect(s.delete('x')).toBe(false);
  });

  it('re-adding an existing value does not trigger spurious eviction', () => {
    const s = new BoundedSet<number>(2);
    s.add(1);
    s.add(2);
    s.add(1); // already present — Set dedupes, size stays 2
    expect(s.size).toBe(2);
    expect(s.has(1)).toBe(true);
    expect(s.has(2)).toBe(true);
  });
});

describe('BoundedMap', () => {
  it('behaves like a normal Map below capacity', () => {
    const m = new BoundedMap<string, number>(5);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.size).toBe(2);
  });

  it('evicts the oldest entry once capacity is exceeded (FIFO)', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3); // exceeds cap of 2 → evicts 'a'

    expect(m.size).toBe(2);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('never exceeds cap across many insertions', () => {
    const m = new BoundedMap<number, string>(10);
    for (let i = 0; i < 500; i++) m.set(i, `v${i}`);
    expect(m.size).toBe(10);
    for (let i = 490; i < 500; i++) expect(m.has(i)).toBe(true);
    expect(m.has(489)).toBe(false);
  });

  it('delete removes an entry', () => {
    const m = new BoundedMap<string, number>(5);
    m.set('x', 1);
    expect(m.delete('x')).toBe(true);
    expect(m.has('x')).toBe(false);
  });

  it('entries() yields all current key/value pairs', () => {
    const m = new BoundedMap<string, number>(5);
    m.set('a', 1);
    m.set('b', 2);
    expect([...m.entries()]).toEqual([['a', 1], ['b', 2]]);
  });

  it('is directly iterable with for...of (Map-like ergonomics)', () => {
    const m = new BoundedMap<string, number>(5);
    m.set('a', 1);
    m.set('b', 2);

    const seen: Array<[string, number]> = [];
    for (const entry of m) {
      seen.push(entry);
    }
    expect(seen).toEqual([['a', 1], ['b', 2]]);
  });
});
