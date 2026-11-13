import { uid } from '@/core/id';
import type { DockGroup, DockLayout, DockNode, DockSplit, DropZone, SplitDir } from './types';

/** Pure(ish) operations on a DockLayout. They mutate the layout they are given. */

export function newGroup(panels: string[], active?: string): DockGroup {
  return { kind: 'group', id: uid('grp'), panels: [...panels], active: active ?? panels[0] ?? '' };
}

export function collectGroups(node: DockNode | null): DockGroup[] {
  if (!node) return [];
  if (node.kind === 'group') return [node];
  return node.children.flatMap((c) => collectGroups(c));
}

export function findGroup(layout: DockLayout, panelId: string): DockGroup | null {
  return collectGroups(layout.root).find((g) => g.panels.includes(panelId)) ?? null;
}

export function findGroupById(layout: DockLayout, id: string): DockGroup | null {
  return collectGroups(layout.root).find((g) => g.id === id) ?? null;
}

export function isPanelOpen(layout: DockLayout, panelId: string): boolean {
  return findGroup(layout, panelId) !== null || layout.floating.some((f) => f.panelId === panelId);
}

export function allPanelIds(layout: DockLayout): string[] {
  return [...collectGroups(layout.root).flatMap((g) => g.panels), ...layout.floating.map((f) => f.panelId)];
}

export function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  if (total <= 0) return sizes.map(() => 1 / Math.max(1, sizes.length));
  return sizes.map((v) => Math.max(0, v) / total);
}

/** Remove empty groups, collapse single-child splits, flatten same-direction nesting. */
export function prune(node: DockNode | null): DockNode | null {
  if (!node) return null;
  if (node.kind === 'group') return node.panels.length > 0 ? node : null;
  const kids: DockNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const p = prune(child);
    if (!p) return;
    const size = node.sizes[i] ?? 1 / node.children.length;
    if (p.kind === 'split' && p.dir === node.dir) {
      const total = p.sizes.reduce((s, v) => s + v, 0) || 1;
      p.children.forEach((pc, j) => {
        kids.push(pc);
        sizes.push((size * (p.sizes[j] ?? 0)) / total);
      });
    } else {
      kids.push(p);
      sizes.push(size);
    }
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0] as DockNode;
  return { kind: 'split', dir: node.dir, children: kids, sizes: normalizeSizes(sizes) };
}

export function findParent(
  root: DockNode | null,
  target: DockNode,
): { parent: DockSplit | null; index: number } {
  if (!root || root === target) return { parent: null, index: -1 };
  const walk = (node: DockNode): { parent: DockSplit; index: number } | null => {
    if (node.kind !== 'split') return null;
    const idx = node.children.indexOf(target);
    if (idx >= 0) return { parent: node, index: idx };
    for (const c of node.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(root) ?? { parent: null, index: -1 };
}

/** Remove a panel from wherever it lives (dock group or floating list). */
export function detachPanel(layout: DockLayout, panelId: string): { groupId: string; index: number } | null {
  const g = findGroup(layout, panelId);
  if (g) {
    const index = g.panels.indexOf(panelId);
    g.panels.splice(index, 1);
    if (g.active === panelId) g.active = g.panels[Math.min(index, g.panels.length - 1)] ?? '';
    layout.root = prune(layout.root);
    if (layout.maximizedGroup && !findGroupById(layout, layout.maximizedGroup)) layout.maximizedGroup = null;
    return { groupId: g.id, index };
  }
  const fi = layout.floating.findIndex((f) => f.panelId === panelId);
  if (fi >= 0) layout.floating.splice(fi, 1);
  return null;
}

export function insertIntoGroup(group: DockGroup, panelId: string, index?: number): void {
  const at = index === undefined ? group.panels.length : Math.max(0, Math.min(index, group.panels.length));
  group.panels.splice(at, 0, panelId);
  group.active = panelId;
}

/** Split `target` and put the panel in a new group on the given side. */
export function splitGroup(layout: DockLayout, panelId: string, target: DockGroup, zone: Exclude<DropZone, 'center'>): DockGroup {
  const dir: SplitDir = zone === 'left' || zone === 'right' ? 'row' : 'column';
  const before = zone === 'left' || zone === 'top';
  const ng = newGroup([panelId]);
  const { parent, index } = findParent(layout.root, target);
  if (parent && parent.dir === dir) {
    const s = parent.sizes[index] ?? 1 / parent.children.length;
    parent.sizes[index] = s / 2;
    const at = before ? index : index + 1;
    parent.sizes.splice(at, 0, s / 2);
    parent.children.splice(at, 0, ng);
  } else {
    const split: DockSplit = {
      kind: 'split',
      dir,
      children: before ? [ng, target] : [target, ng],
      sizes: [0.5, 0.5],
    };
    if (parent) parent.children[index] = split;
    else layout.root = split;
  }
  return ng;
}
