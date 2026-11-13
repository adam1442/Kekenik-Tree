import type { FileHandleLike } from './fileAccess';
import type { KeyValueStore } from './kvStore';

const KEY = 'recent';
const MAX_RECENT = 10;
/** Cached copies above this size are not stored (the handle, when available, is enough). */
const MAX_CACHED_BYTES = 8 * 1024 * 1024;

export interface RecentEntry {
  /** File name, also the identity (re-opening the same name moves it to the top). */
  name: string;
  openedAt: number;
  handle?: FileHandleLike;
  /** Cached encoded project so recent files re-open in browsers without persistent handles. */
  bytes?: Uint8Array;
}

const isEntry = (v: unknown): v is RecentEntry => typeof v === 'object' && v !== null && typeof (v as RecentEntry).name === 'string' && typeof (v as RecentEntry).openedAt === 'number';

export class RecentFiles {
  constructor(private readonly kv: KeyValueStore) {}

  async list(): Promise<RecentEntry[]> {
    const raw = await this.kv.get(KEY);
    return Array.isArray(raw) ? raw.filter(isEntry).slice(0, MAX_RECENT) : [];
  }

  async add(entry: { name: string; handle: FileHandleLike | null; bytes: Uint8Array }): Promise<void> {
    const rest = (await this.list()).filter((e) => e.name !== entry.name);
    const next: RecentEntry = { name: entry.name, openedAt: Date.now(), ...(entry.handle ? { handle: entry.handle } : {}), ...(entry.bytes.length <= MAX_CACHED_BYTES ? { bytes: entry.bytes } : {}) };
    await this.kv.set(KEY, [next, ...rest].slice(0, MAX_RECENT));
  }

  async remove(name: string): Promise<void> {
    await this.kv.set(KEY, (await this.list()).filter((e) => e.name !== name));
  }

  async clear(): Promise<void> {
    await this.kv.set(KEY, []);
  }
}
