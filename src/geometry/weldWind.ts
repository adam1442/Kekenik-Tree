import { WIND_ATTRIBUTES, type WindTuple } from './windAttributes';

/**
 * Wind of a weld / collar ring. The first rings of a welded child lie on the parent's skin and must move exactly like the parent
 * surface vertex they sit on; they fade into the child's own wind with the same curve (`WeldResult.blend`) that fades the normals.
 */

/** Wind of the parent skeleton near a welded child: the five per-point channels of the parent branch and its base (the wind pivot). */
export interface ParentWindSource {
  /** `WIND_ATTRIBUTES` arrays indexed by the parent skeleton's global point index. */
  arrays: readonly Float32Array[];
  /** Global index of the first point of the parent branch. */
  start: number;
  count: number;
  /** Parent skeleton positions (xyz per global point). */
  position: ArrayLike<number>;
}

/** Parent wind arrays of a skeleton attribute map, or null when one of the channels is missing. */
export function windArraysOf(attributes: ReadonlyMap<string, Float32Array>): Float32Array[] | null {
  const out: Float32Array[] = [];
  for (const k of WIND_ATTRIBUTES) {
    const a = attributes.get(k);
    if (!a) return null;
    out.push(a);
  }
  return out;
}

/** Interpolation between two phases (0..1, cyclic) along the shorter arc; `t` = 0 gives `a`, 1 gives `b`. */
export function lerpPhase(a: number, b: number, t: number): number {
  let d = b - a;
  d -= Math.round(d);
  const r = a + d * t;
  return r - Math.floor(r);
}

/**
 * Wind tuple of the parent skin at world point `p`: the point is projected on the parent's spine (nearest segment), the weights and
 * the leaf phase interpolate along it like the parent's own rings do, the level-1 phase is the nearest point's value.
 */
export function parentWindAt(src: ParentWindSource, x: number, y: number, z: number): WindTuple {
  const pos = src.position;
  let bestD = Infinity;
  let bestK = 0;
  let bestU = 0;
  for (let k = 0; k + 1 < src.count; k++) {
    const a = (src.start + k) * 3;
    const b = a + 3;
    const ex = (pos[b] as number) - (pos[a] as number);
    const ey = (pos[b + 1] as number) - (pos[a + 1] as number);
    const ez = (pos[b + 2] as number) - (pos[a + 2] as number);
    const wx = x - (pos[a] as number);
    const wy = y - (pos[a + 1] as number);
    const wz = z - (pos[a + 2] as number);
    const l2 = ex * ex + ey * ey + ez * ez;
    const u = l2 > 1e-18 ? Math.min(1, Math.max(0, (wx * ex + wy * ey + wz * ez) / l2)) : 0;
    const d = (wx - ex * u) ** 2 + (wy - ey * u) ** 2 + (wz - ez * u) ** 2;
    if (d < bestD) {
      bestD = d;
      bestK = k;
      bestU = u;
    }
  }
  const i0 = src.start + bestK;
  const i1 = Math.min(src.start + src.count - 1, i0 + 1);
  const at = (c: number, u: number): number => {
    const arr = src.arrays[c] as Float32Array;
    return (arr[i0] as number) * (1 - u) + (arr[i1] as number) * u;
  };
  const nearest = bestU < 0.5 ? i0 : i1;
  return [at(0, bestU), at(1, bestU), at(2, bestU), at(3, bestU), (src.arrays[4] as Float32Array)[nearest] as number];
}

/** Weld wind: `parent` weight `w` (1 on the skin .. 0 = the child's own value). Phases blend along the shorter arc. */
export function blendWeldWind(parent: readonly number[], own: readonly number[], w: number): WindTuple {
  const m = (a: number, b: number): number => b + (a - b) * w;
  return [
    m(parent[0] as number, own[0] as number),
    m(parent[1] as number, own[1] as number),
    m(parent[2] as number, own[2] as number),
    lerpPhase(own[3] as number, parent[3] as number, w),
    lerpPhase(own[4] as number, parent[4] as number, w),
  ];
}
