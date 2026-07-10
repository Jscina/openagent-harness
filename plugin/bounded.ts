// ─── Bounded collections ──────────────────────────────────────────────────────
//
// Fixed-capacity Set/Map with FIFO eviction, used for long-lived plugin state
// that must not grow unbounded across the lifetime of a long-running
// OpenCode process (e.g. cancelled-session tracking, deferred review
// buffering). `Map`/`Set` iteration order in JS is insertion order, so
// `.values().next().value` / `.keys().next().value` always yields the
// oldest entry — that's what makes the eviction FIFO.

export class BoundedSet<T> {
  private readonly store = new Set<T>();

  constructor(private readonly cap: number) {}

  add(value: T): void {
    this.store.add(value);
    if (this.store.size > this.cap) {
      const oldest = this.store.values().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  has(value: T): boolean {
    return this.store.has(value);
  }

  delete(value: T): boolean {
    return this.store.delete(value);
  }

  get size(): number {
    return this.store.size;
  }
}

export class BoundedMap<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly cap: number) {}

  set(key: K, value: V): void {
    this.store.set(key, value);
    if (this.store.size > this.cap) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
  }

  get(key: K): V | undefined {
    return this.store.get(key);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  entries(): IterableIterator<[K, V]> {
    return this.store.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.store.entries();
  }
}
