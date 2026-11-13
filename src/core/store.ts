/**
 * Tiny observable store with shallow-merge updates and selector subscriptions.
 */
export type StoreListener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<StoreListener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  /** Shallow-merge a patch. Listeners fire only if at least one key changed. */
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const key of Object.keys(next) as (keyof T)[]) {
      if (!Object.is(this.state[key], next[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const prev = this.state;
    this.state = { ...prev, ...next };
    for (const fn of [...this.listeners]) fn(this.state, prev);
  }

  subscribe(fn: StoreListener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to a derived value; callback fires only when it changes. */
  select<S>(
    selector: (state: T) => S,
    fn: (value: S, prev: S) => void,
    equals: (a: S, b: S) => boolean = Object.is,
  ): () => void {
    return this.subscribe((state, prev) => {
      const a = selector(state);
      const b = selector(prev);
      if (!equals(a, b)) fn(a, b);
    });
  }
}
