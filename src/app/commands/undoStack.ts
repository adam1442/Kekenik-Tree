import type { AppState, Command } from '@/contracts/app';
import type { Store } from '@/core/store';

export interface HistoryEntry {
  label: string;
  /** false = applied, true = currently undone (redo-able). */
  undone: boolean;
}

interface Bucket {
  undo: Command[];
  redo: Command[];
  /** Number of undo entries at the last save; -1 = the saved state is no longer reachable. */
  savedAt: number;
  /** When true the next command may not merge into the top entry. */
  sealed: boolean;
}

function newBucket(): Bucket {
  return { undo: [], redo: [], savedAt: 0, sealed: false };
}

/**
 * Undo/redo history with one independent history per context (= document).
 * - `execute()` runs a command and pushes it, merging into the previous entry when `previous.merge(next)` accepts
 *   (continuous drags / slider scrubs). Call `seal()` when a gesture ends so the next gesture starts a new entry.
 * - `dirty` is derived from the position of the save point.
 * Publishes canUndo/canRedo/labels/dirty into the app store.
 */
export class UndoStack {
  private readonly buckets = new Map<string, Bucket>();
  private bucket: Bucket = newBucket();
  private contextId = 'default';
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: Store<AppState>,
    private readonly limit = 200,
  ) {
    this.buckets.set(this.contextId, this.bucket);
  }

  /** Switch to another history (created lazily). */
  setContext(id: string): void {
    if (id === this.contextId) return;
    this.contextId = id;
    let b = this.buckets.get(id);
    if (!b) {
      b = newBucket();
      this.buckets.set(id, b);
    }
    this.bucket = b;
    this.publish();
  }

  dropContext(id: string): void {
    if (id === this.contextId) return;
    this.buckets.delete(id);
  }

  execute(cmd: Command): void {
    const b = this.bucket;
    cmd.do();
    const last = b.undo[b.undo.length - 1];
    const merged = !b.sealed && last?.merge?.(cmd) === true;
    if (merged) {
      if (b.savedAt === b.undo.length) b.savedAt = -1;
    } else {
      if (b.savedAt > b.undo.length) b.savedAt = -1;
      b.undo.push(cmd);
      if (b.undo.length > this.limit) {
        b.undo.shift();
        b.savedAt = b.savedAt > 0 ? b.savedAt - 1 : -1;
      }
    }
    b.redo = [];
    b.sealed = false;
    this.publish();
  }

  /** End of a continuous gesture: following commands start a new history entry. */
  seal(): void {
    this.bucket.sealed = true;
  }

  undo(): void {
    const cmd = this.bucket.undo.pop();
    if (!cmd) return;
    cmd.undo();
    this.bucket.redo.push(cmd);
    this.bucket.sealed = true;
    this.publish();
  }

  redo(): void {
    const cmd = this.bucket.redo.pop();
    if (!cmd) return;
    cmd.do();
    this.bucket.undo.push(cmd);
    this.bucket.sealed = true;
    this.publish();
  }

  /** Undo/redo until exactly `doneCount` entries are applied (history panel: click an entry). */
  jumpTo(doneCount: number): void {
    const target = Math.max(0, Math.min(doneCount, this.bucket.undo.length + this.bucket.redo.length));
    while (this.bucket.undo.length > target) this.undo();
    while (this.bucket.undo.length < target && this.bucket.redo.length > 0) this.redo();
  }

  /** Oldest first: applied entries followed by undone ones (next redo first). */
  history(): HistoryEntry[] {
    const b = this.bucket;
    return [
      ...b.undo.map((c): HistoryEntry => ({ label: c.label, undone: false })),
      ...[...b.redo].reverse().map((c): HistoryEntry => ({ label: c.label, undone: true })),
    ];
  }

  get dirty(): boolean {
    return this.bucket.savedAt !== this.bucket.undo.length;
  }

  markClean(): void {
    this.bucket.savedAt = this.bucket.undo.length;
    this.publish();
  }

  /** Mark the active document as having unsaved changes without an undo entry (crash recovery restores). */
  markDirty(): void {
    this.bucket.savedAt = -1;
    this.publish();
  }

  clear(): void {
    this.bucket.undo = [];
    this.bucket.redo = [];
    this.bucket.savedAt = 0;
    this.bucket.sealed = false;
    this.publish();
  }

  /** Subscribe to history changes (history panel hook). Returns unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish(): void {
    const u = this.bucket.undo[this.bucket.undo.length - 1];
    const r = this.bucket.redo[this.bucket.redo.length - 1];
    this.store.set({
      canUndo: this.bucket.undo.length > 0,
      canRedo: this.bucket.redo.length > 0,
      undoLabel: u?.label ?? '',
      redoLabel: r?.label ?? '',
      dirty: this.dirty,
    });
    for (const fn of [...this.listeners]) fn();
  }
}
