import type { KeyValueStore } from './kvStore';

const PREFIX = 'autosave/';

/** One recoverable document. `bytes` is an encoded ProjectFile (see codec.ts). */
export interface AutosaveRecord {
  docId: string;
  name: string;
  fileName: string | null;
  savedAt: number;
  bytes: Uint8Array;
}

const isRecord = (v: unknown): v is AutosaveRecord =>
  typeof v === 'object' && v !== null && typeof (v as AutosaveRecord).docId === 'string' && typeof (v as AutosaveRecord).name === 'string' && (v as AutosaveRecord).bytes instanceof Uint8Array;

/** Crash-recovery storage: one record per dirty document. Records are removed on save / explicit close. */
export class AutosaveStore {
  constructor(private readonly kv: KeyValueStore) {}

  write(record: AutosaveRecord): Promise<void> {
    return this.kv.set(PREFIX + record.docId, record);
  }

  remove(docId: string): Promise<void> {
    return this.kv.delete(PREFIX + docId);
  }

  async list(): Promise<AutosaveRecord[]> {
    const out: AutosaveRecord[] = [];
    for (const key of await this.kv.keys(PREFIX)) {
      const v = await this.kv.get(key);
      if (isRecord(v)) out.push(v);
      else await this.kv.delete(key);
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async clear(): Promise<void> {
    for (const key of await this.kv.keys(PREFIX)) await this.kv.delete(key);
  }
}

/** Run `fn` at most once per `delayMs` after the last `trigger()`. */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly fn: () => void,
    private readonly delayMs: number,
  ) {}
  trigger(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fn();
    }, this.delayMs);
  }
  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.fn();
  }
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
