/**
 * Typed event bus. `E` maps event names to payload types.
 * Use `undefined` as payload for events without data.
 */
export class EventBus<E extends object> {
  private listeners = new Map<keyof E, Set<(payload: unknown) => void>>();

  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const wrapped = fn as (payload: unknown) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
