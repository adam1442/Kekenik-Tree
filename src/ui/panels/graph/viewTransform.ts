/** Pan/zoom math for the graph canvas (pure). screen = world * k + (x, y). */
export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 4;

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

export function screenToWorld(view: View, sx: number, sy: number): Pt {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}

export function worldToScreen(view: View, wx: number, wy: number): Pt {
  return { x: wx * view.k + view.x, y: wy * view.k + view.y };
}

/** Zoom by `factor` keeping the world point under screen position (sx, sy) fixed. */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const k = clampZoom(view.k * factor);
  const real = k / view.k;
  return { k, x: sx - (sx - view.x) * real, y: sy - (sy - view.y) * real };
}

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** View that shows `rect` centred with `padding` screen pixels around; zoom never exceeds `maxK`. */
export function fitView(rect: WorldRect, width: number, height: number, padding = 40, maxK = 1.4): View {
  const w = Math.max(1, rect.maxX - rect.minX);
  const h = Math.max(1, rect.maxY - rect.minY);
  const k = clampZoom(Math.min(maxK, Math.max(1, width - padding * 2) / w, Math.max(1, height - padding * 2) / h));
  const cx = (rect.minX + rect.maxX) / 2;
  const cy = (rect.minY + rect.maxY) / 2;
  return { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
}

/** Grid step in world units so that the on-screen spacing stays within [12, 60) px (steps by factors of 5). */
export function adaptiveGridStep(k: number, base: number): number {
  let step = base;
  let screen = step * k;
  while (screen < 12) {
    step *= 5;
    screen *= 5;
  }
  while (screen >= 60) {
    step /= 5;
    screen /= 5;
  }
  return step;
}

export function lerpView(a: View, b: View, t: number): View {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, k: a.k + (b.k - a.k) * t };
}
