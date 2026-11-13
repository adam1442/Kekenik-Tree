/** Pure layout helpers: tidy tree (root at the bottom, children above), align, distribute, snapping, free slots. */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
}

export interface TreeLink {
  parent: string;
  child: string;
}

export interface Point {
  x: number;
  y: number;
}

export const H_SPACING = 52;
export const V_SPACING = 52;

/**
 * Hierarchical tidy tree: parents are centred under their children, leaves occupy
 * consecutive slots (subtrees never overlap), depth maps to rows. Children keep their current left-to-right order.
 * A single tree stays anchored at its root; forests keep their bounding-box centre and bottom edge.
 */
export function tidyTreeLayout(nodes: LayoutNode[], links: TreeLink[], hSpacing = H_SPACING, vSpacing = V_SPACING): Map<string, Point> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const l of links) {
    if (!byId.has(l.parent) || !byId.has(l.child)) continue;
    let list = children.get(l.parent);
    if (!list) {
      list = [];
      children.set(l.parent, list);
    }
    list.push(l.child);
    hasParent.add(l.child);
  }
  const xOf = (id: string): number => byId.get(id)?.x ?? 0;
  for (const list of children.values()) list.sort((a, b) => xOf(a) - xOf(b));
  const roots = nodes.filter((n) => !hasParent.has(n.id)).sort((a, b) => a.x - b.x);

  const result = new Map<string, Point>();
  let slot = 0;
  const place = (id: string, depth: number): number => {
    if (result.has(id)) return result.get(id)?.x ?? 0;
    result.set(id, { x: 0, y: -depth * vSpacing });
    const kids = children.get(id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = slot * hSpacing;
      slot += 1;
    } else {
      const xs = kids.map((k) => place(k, depth + 1));
      x = ((xs[0] ?? 0) + (xs[xs.length - 1] ?? 0)) / 2;
    }
    result.set(id, { x, y: -depth * vSpacing });
    return x;
  };
  for (const r of roots) {
    place(r.id, 0);
    slot += 0.5;
  }
  // Leftover nodes inside cycles (should not exist) keep their place.
  for (const n of nodes) if (!result.has(n.id)) result.set(n.id, { x: n.x, y: n.y });

  const laid = [...result.keys()].map((id) => byId.get(id) as LayoutNode);
  let dx: number;
  let dy: number;
  const first = roots[0];
  if (roots.length === 1 && first) {
    const p = result.get(first.id) as Point;
    dx = first.x - p.x;
    dy = first.y - p.y;
  } else {
    const oldB = bounds(laid);
    const newB = bounds([...result.entries()].map(([id, p]) => ({ id, ...p })));
    dx = (oldB.minX + oldB.maxX) / 2 - (newB.minX + newB.maxX) / 2;
    dy = oldB.maxY - newB.maxY;
  }
  for (const [id, p] of result) result.set(id, { x: p.x + dx, y: p.y + dy });
  return result;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bounds(items: Point[]): Bounds {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of items) {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  }
  if (items.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return b;
}

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

export function alignPositions(items: LayoutNode[], mode: AlignMode): Map<string, Point> {
  const b = bounds(items);
  const out = new Map<string, Point>();
  for (const n of items) {
    const p = { x: n.x, y: n.y };
    if (mode === 'left') p.x = b.minX;
    else if (mode === 'right') p.x = b.maxX;
    else if (mode === 'top') p.y = b.minY;
    else if (mode === 'bottom') p.y = b.maxY;
    else if (mode === 'centerX') p.x = (b.minX + b.maxX) / 2;
    else p.y = (b.minY + b.maxY) / 2;
    out.set(n.id, p);
  }
  return out;
}

/** Spread items evenly along an axis between the two outermost ones (needs >= 3 items to change anything). */
export function distributePositions(items: LayoutNode[], axis: 'x' | 'y'): Map<string, Point> {
  const sorted = [...items].sort((a, b) => a[axis] - b[axis]);
  const out = new Map<string, Point>();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  sorted.forEach((n, i) => {
    const t = sorted.length > 1 ? i / (sorted.length - 1) : 0;
    const v = first && last ? first[axis] + (last[axis] - first[axis]) * t : n[axis];
    out.set(n.id, axis === 'x' ? { x: v, y: n.y } : { x: n.x, y: v });
  });
  return out;
}

/** Nearest free spot starting at (x, y), probing sideways in `spacing` steps (0, +1, -1, +2, -2 ...). */
export function findFreeSlot(occupied: Point[], x: number, y: number, spacing = H_SPACING, minDist = 40): Point {
  const free = (px: number): boolean => occupied.every((o) => Math.hypot(o.x - px, o.y - y) >= minDist);
  for (let i = 0; i < 400; i++) {
    const step = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const px = x + step * spacing;
    if (free(px)) return { x: px, y };
  }
  return { x, y };
}
