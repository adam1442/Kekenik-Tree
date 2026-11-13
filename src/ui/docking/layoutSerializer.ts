import { uid } from '@/core/id';
import { insertIntoGroup, newGroup, normalizeSizes, prune, collectGroups } from './layoutOps';
import { LAYOUT_VERSION, type DockGroup, type DockLayout, type DockNode, type FloatingPanel } from './types';

/** JSON (de)serialisation, validation and migration of dock layouts. */

export function serializeLayout(layout: DockLayout): string {
  return JSON.stringify(layout);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export interface ParseOptions {
  /** Panels that exist in the registry. Unknown ids are dropped. */
  known: ReadonlySet<string>;
  /** Panels that must always be present (non-closable, e.g. viewport). */
  required: readonly string[];
}

/** Parse + validate. Returns null if the data is unusable. */
export function parseLayout(raw: unknown, opts: ParseOptions): DockLayout | null {
  if (!isObj(raw)) return null;
  // Migration hook: versions < 1 do not exist; anything else than the current version is rejected.
  if (raw.version !== LAYOUT_VERSION) return null;
  const seen = new Set<string>();
  const usedIds = new Set<string>();

  const parseNode = (n: unknown): DockNode | null => {
    if (!isObj(n)) return null;
    if (n.kind === 'group') {
      if (!Array.isArray(n.panels)) return null;
      const panels: string[] = [];
      for (const p of n.panels) {
        if (typeof p !== 'string' || !opts.known.has(p) || seen.has(p)) continue;
        seen.add(p);
        panels.push(p);
      }
      if (panels.length === 0) return null;
      let id = typeof n.id === 'string' ? n.id : uid('grp');
      if (usedIds.has(id)) id = uid('grp');
      usedIds.add(id);
      const group: DockGroup = {
        kind: 'group',
        id,
        panels,
        active: typeof n.active === 'string' && panels.includes(n.active) ? n.active : (panels[0] as string),
      };
      if (n.collapsed === true) group.collapsed = true;
      return group;
    }
    if (n.kind === 'split' && (n.dir === 'row' || n.dir === 'column') && Array.isArray(n.children)) {
      const children: DockNode[] = [];
      const sizes: number[] = [];
      const rawChildren: unknown[] = n.children;
      const rawSizes: unknown = n.sizes;
      rawChildren.forEach((c, i) => {
        const p = parseNode(c);
        if (!p) return;
        children.push(p);
        sizes.push(Math.max(0.02, num(Array.isArray(rawSizes) ? rawSizes[i] : undefined, 1 / rawChildren.length)));
      });
      if (children.length === 0) return null;
      return { kind: 'split', dir: n.dir, children, sizes: normalizeSizes(sizes) };
    }
    return null;
  };

  const root = prune(raw.root === null ? null : parseNode(raw.root));
  const floating: FloatingPanel[] = [];
  if (Array.isArray(raw.floating)) {
    for (const f of raw.floating) {
      if (!isObj(f) || typeof f.panelId !== 'string' || !opts.known.has(f.panelId) || seen.has(f.panelId)) continue;
      const r = isObj(f.rect) ? f.rect : {};
      seen.add(f.panelId);
      const fp: FloatingPanel = {
        id: typeof f.id === 'string' ? f.id : uid('fp'),
        panelId: f.panelId,
        rect: { x: num(r.x, 40), y: num(r.y, 40), w: Math.max(120, num(r.w, 360)), h: Math.max(80, num(r.h, 420)) },
        minimized: f.minimized === true,
        maximized: f.maximized === true,
      };
      if (isObj(f.home) && typeof f.home.groupId === 'string') fp.home = { groupId: f.home.groupId, index: num(f.home.index, 0) };
      floating.push(fp);
    }
  }
  const layout: DockLayout = {
    version: LAYOUT_VERSION,
    root,
    floating,
    maximizedGroup: typeof raw.maximizedGroup === 'string' ? raw.maximizedGroup : null,
  };
  if (layout.maximizedGroup && !collectGroups(layout.root).some((g) => g.id === layout.maximizedGroup)) layout.maximizedGroup = null;
  for (const req of opts.required) {
    if (seen.has(req)) continue;
    const first = collectGroups(layout.root)[0];
    if (first) {
      const prevActive = first.active;
      insertIntoGroup(first, req);
      first.active = prevActive; // do not steal focus from the user's active tab
    }
    else layout.root = newGroup([req]);
  }
  return layout;
}

