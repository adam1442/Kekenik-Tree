import { describe, expect, it } from 'vitest';
import { createSimplex } from '@/core/noise';
import { Rng } from '@/core/rng';
import { Store } from '@/core/store';
import { EventBus } from '@/core/eventBus';

describe('Rng', () => {
  it('is deterministic for the same seed', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    for (let i = 0; i < 20; i++) expect(a.next()).toBe(b.next());
  });

  it('differs between seeds and stays in [0,1)', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
    for (let i = 0; i < 200; i++) {
      const v = a.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('fork streams are stable and independent of parent draws', () => {
    const a = new Rng(99);
    const b = new Rng(99);
    a.next();
    a.next();
    expect(a.fork('leaf').next()).toBe(b.fork('leaf').next());
    expect(a.fork('leaf').next()).not.toBe(a.fork('branch').next());
  });

  it('int() is inclusive', () => {
    const r = new Rng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) seen.add(r.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });
});

describe('simplex noise', () => {
  it('is deterministic and bounded', () => {
    const n1 = createSimplex(7);
    const n2 = createSimplex(7);
    for (let i = 0; i < 50; i++) {
      const v = n1.noise3(i * 0.37, i * 0.11, i * 0.73);
      expect(v).toBe(n2.noise3(i * 0.37, i * 0.11, i * 0.73));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.05);
    }
  });
});

describe('Store', () => {
  it('notifies only on change and supports select()', () => {
    const s = new Store({ a: 1, b: 2 });
    let calls = 0;
    let selected = 0;
    s.subscribe(() => calls++);
    s.select((x) => x.a, () => selected++);
    s.set({ a: 1 });
    expect(calls).toBe(0);
    s.set({ b: 3 });
    expect(calls).toBe(1);
    expect(selected).toBe(0);
    s.set({ a: 5 });
    expect(selected).toBe(1);
  });
});

describe('EventBus', () => {
  it('delivers and unsubscribes', () => {
    const bus = new EventBus<{ ping: number }>();
    const got: number[] = [];
    const off = bus.on('ping', (n) => got.push(n));
    bus.emit('ping', 1);
    off();
    bus.emit('ping', 2);
    expect(got).toEqual([1]);
  });
});
