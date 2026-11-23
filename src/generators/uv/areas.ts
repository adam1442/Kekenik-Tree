import type { Rng } from '@/core/rng';
import type { UvRect } from './types';

export const WHOLE_MAP: UvRect = [0, 0, 1, 1];

/** UV Area values stored in a material row besides a concrete area id. */
export const UV_AREA_WHOLE = 'whole';
export const UV_AREA_ANY = 'any';

/** The part of a UV Area definition the patch generator needs. */
export interface UvAreaLike {
  id: string;
  name: string;
  materialId: string;
  rect: UvRect;
  usage: string;
  weight: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Clamps a rectangle into the 0..1 square and orders its corners (a degenerate rectangle becomes the whole map). */
export function normalizeRect(r: UvRect): UvRect {
  const u0 = clamp01(Math.min(r[0], r[2]));
  const u1 = clamp01(Math.max(r[0], r[2]));
  const v0 = clamp01(Math.min(r[1], r[3]));
  const v1 = clamp01(Math.max(r[1], r[3]));
  return u1 - u0 < 1e-6 || v1 - v0 < 1e-6 ? WHOLE_MAP : [u0, v0, u1, v1];
}

/** Maps a coordinate of a 0..1 patch into the UV Area rectangle. The result stays inside the rectangle. */
export function remapToRect(rect: UvRect, u: number, v: number): [number, number] {
  const cu = clamp01(u);
  const cv = clamp01(v);
  return [rect[0] + (rect[2] - rect[0]) * cu, rect[1] + (rect[3] - rect[1]) * cv];
}

/** Areas that may be used on bark: usage `any` or `bark`. */
const barkAreas = (areas: readonly UvAreaLike[], materialId: string): UvAreaLike[] =>
  areas.filter((a) => a.materialId === materialId && (a.usage === 'any' || a.usage === 'bark'));

/**
 * Rectangle of a row's UV Area: `whole` (or empty) = the whole map, `any` = a weighted pick among the bark areas of the
 * material (one draw; whole map when it has none), otherwise the area with that id / name (whole map when unknown).
 */
export function resolveAreaRect(ref: string, materialId: string, areas: readonly UvAreaLike[], rng: Rng): UvRect {
  if (!ref || ref === UV_AREA_WHOLE) return WHOLE_MAP;
  if (ref === UV_AREA_ANY) {
    const list = barkAreas(areas, materialId);
    const r = rng.next();
    if (list.length === 0) return WHOLE_MAP;
    let total = 0;
    for (const a of list) total += Math.max(0, a.weight);
    if (total <= 0) return normalizeRect((list[0] as UvAreaLike).rect);
    let acc = 0;
    for (const a of list) {
      acc += Math.max(0, a.weight) / total;
      if (r < acc) return normalizeRect(a.rect);
    }
    return normalizeRect((list[list.length - 1] as UvAreaLike).rect);
  }
  const named = areas.find((a) => a.materialId === materialId && (a.id === ref || a.name === ref)) ?? areas.find((a) => a.id === ref || a.name === ref);
  return named ? normalizeRect(named.rect) : WHOLE_MAP;
}
