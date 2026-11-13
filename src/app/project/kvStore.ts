/** Minimal async key-value storage (IndexedDB in the app, a Map in tests). Never rejects: failures degrade to no-ops. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}

export class MemoryKeyValueStore implements KeyValueStore {
  readonly map = new Map<string, unknown>();
  get(key: string): Promise<unknown> {
    return Promise.resolve(this.map.has(key) ? structuredClone(this.map.get(key)) : undefined);
  }
  set(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  keys(prefix = ''): Promise<string[]> {
    return Promise.resolve([...this.map.keys()].filter((k) => k.startsWith(prefix)));
  }
}

const DB_NAME = 'kekenik-tree';
const STORE = 'kv';

export class IndexedDbKeyValueStore implements KeyValueStore {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    this.dbPromise ??= new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = (): void => {
          req.result.createObjectStore(STORE);
        };
        req.onsuccess = (): void => resolve(req.result);
        req.onerror = (): void => resolve(null);
        req.onblocked = (): void => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
    const db = await this.open();
    if (!db) return fallback;
    return new Promise<T>((resolve) => {
      try {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = (): void => resolve(req.result as T);
        req.onerror = (): void => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  }

  get(key: string): Promise<unknown> {
    return this.run('readonly', (s) => s.get(key), undefined as unknown);
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.run('readwrite', (s) => s.put(value, key), undefined as unknown);
  }
  async delete(key: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(key), undefined as unknown);
  }
  async keys(prefix = ''): Promise<string[]> {
    const all = await this.run('readonly', (s) => s.getAllKeys(), [] as IDBValidKey[]);
    return all.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
  }
}
