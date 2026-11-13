import { getApp } from '@/app/context';
import { getMaterialLibrary, type LibraryChange, type LibraryKind, type MaterialLibrary } from '@/materials/library';
import { h } from '../../components/dom';
import type { PanelInstance } from '../../docking/panelRegistry';
import { createAssetHeader, type AssetHeader } from './assetHeader';

type Entry = { id: string; name: string };

export interface AssetPanelContext<T extends Entry> {
  lib: MaterialLibrary;
  /** Selected asset (null when the list is empty). */
  entry: T | null;
  body: HTMLElement;
  /** Edit through the library (undoable). The panel does not rebuild for its own edits. */
  edit(label: string, mutator: (entry: T) => void, mergeKey?: string): void;
  rerender(): void;
  header: AssetHeader;
}

export interface AssetPanelOptions<T extends Entry> {
  kind: LibraryKind;
  noun: string;
  className: string;
  /** Hand tool in the header (panels without their own preview). */
  hand?: boolean;
  /** Called once with the header so panels can hook the hand button / extra rows. */
  build(ctx: AssetPanelContext<T>): void | (() => void);
  /** Extra library kinds that should trigger a rebuild (e.g. Material Sets depend on materials). */
  alsoKinds?: LibraryKind[];
  /** Rows between the header and the body (e.g. the Materials preview). */
  beforeBody?: (ctx: AssetPanelContext<T>) => HTMLElement | null;
}

const lastSelected = new Map<LibraryKind, string>();

/**
 * Common scaffolding of the asset panels: shared header (hand / dropdown / duplicate / add / clipboard), selection
 * memory, undoable edits and a rebuild when the library changes from elsewhere (undo, paste, other panels).
 */
export function mountAssetPanel<T extends Entry>(host: HTMLElement, o: AssetPanelOptions<T>): PanelInstance {
  const app = getApp();
  const lib = getMaterialLibrary();
  host.classList.add('kt-asset-panel', o.className);

  const list = (): T[] =>
    (o.kind === 'materials'
      ? lib.materials()
      : o.kind === 'materialSets'
        ? lib.sets()
        : o.kind === 'masks'
          ? lib.masks()
          : o.kind === 'displacements'
            ? lib.displacements()
            : o.kind === 'meshes'
              ? lib.cutoutMeshes()
              : lib.uvAreas()) as unknown as T[];
  const selectedId = (): string | null => {
    const items = list();
    const keep = lastSelected.get(o.kind);
    return items.find((i) => i.id === keep)?.id ?? items[0]?.id ?? null;
  };
  let hand = false;
  const select = (id: string): void => {
    lastSelected.set(o.kind, id);
    header.refresh();
    rebuild();
  };

  const header = createAssetHeader({
    noun: o.noun,
    items: () => list(),
    selected: selectedId,
    onSelect: select,
    onAdd: () => select(lib.add(o.kind)),
    onDuplicate: () => {
      const id = selectedId();
      const copy = id ? lib.duplicate(o.kind, id) : null;
      if (copy) select(copy);
    },
    onRename: (id, name) => lib.rename(o.kind, id, name),
    onDelete: (id) => lib.remove(o.kind, id),
    onMove: (id, d) => lib.move(o.kind, id, d),
    copy: () => {
      const e = list().find((x) => x.id === selectedId());
      return e ? JSON.stringify({ kekenik: o.kind, data: e }) : null;
    },
    paste: (text) => {
      try {
        const parsed = JSON.parse(text) as { kekenik?: string; data?: Entry };
        if (parsed.kekenik !== o.kind || !parsed.data) throw new Error('wrong kind');
        select(lib.insert(o.kind, parsed.data));
      } catch {
        app.notify(`The clipboard does not contain a ${o.noun}.`);
      }
    },
    hand: o.hand ? { active: () => hand, toggle: () => (hand = !hand) } : undefined,
  });

  const bodyHost = h('div', 'kt-asset-body');
  let before: HTMLElement | null = null;
  let cleanup: void | (() => void);
  let editing = false;

  const makeCtx = (): AssetPanelContext<T> => ({
    lib,
    entry: list().find((x) => x.id === selectedId()) ?? null,
    body: bodyHost,
    header,
    rerender: rebuild,
    edit(label, mutator, mergeKey) {
      const id = selectedId();
      if (!id) return;
      editing = true;
      try {
        lib.edit(label, o.kind, () => {
          const e = list().find((x) => x.id === id);
          if (e) mutator(e);
        }, mergeKey ? `${o.kind}:${id}:${mergeKey}` : undefined);
      } finally {
        editing = false;
      }
    },
  });

  function rebuild(): void {
    if (typeof cleanup === 'function') cleanup();
    const scroll = bodyHost.scrollTop;
    const ctx = makeCtx();
    const nextBefore = o.beforeBody?.(ctx) ?? null;
    if (before) before.replaceWith(...(nextBefore ? [nextBefore] : []));
    else if (nextBefore) header.el.after(nextBefore);
    before = nextBefore;
    bodyHost.replaceChildren();
    cleanup = o.build(ctx);
    header.refresh();
    bodyHost.scrollTop = scroll;
  }

  host.append(header.el, bodyHost);
  rebuild();

  const kinds = new Set<LibraryKind | 'all'>([o.kind, 'all', ...(o.alsoKinds ?? [])]);
  const unsub = lib.onChange((c: LibraryChange) => {
    if (c.kind === 'season' || !kinds.has(c.kind)) return;
    if (editing && c.kind === o.kind) {
      header.refresh();
      return;
    }
    rebuild();
  });
  return {
    dispose() {
      unsub();
      if (typeof cleanup === 'function') cleanup();
    },
  };
}
