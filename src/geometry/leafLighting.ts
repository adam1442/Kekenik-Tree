import type { LeafLightingSettings } from '@/contracts/lighting';
import type { MeshData } from '@/contracts/mesh';
import { deg2rad } from '@/core/math';
import { norm, rotate, type V3 } from './math3';

/**
 * Normal-editing pass of the Leaf "Lighting" tab (reused by the Frond generator).
 *
 * Order (every step works on the vertex normals only, geometry never moves):
 *  Smooth -> Parent puffiness -> Unify -> Adjustments (Up / Right / Out) -> Puffiness -> World up.
 * World up comes last so it overrides puffiness and the adjustments. Tangents are re-orthogonalised to the result.
 */

/** One independently lit piece of the mesh (a leaf card): vertex / index ranges plus its per-leaf lighting inputs. */
export interface LightingGroup {
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  /** Point the Parent puffiness normals radiate from; null = none. */
  anchor: V3 | null;
  /** Fixed direction for the Surface X / Y / Z anchors (wins over `anchor`); null = none. */
  surface: V3 | null;
  /** Local axes of the leaf (X across, Y along, Z face normal). */
  frame: { x: V3; y: V3; z: V3 };
  /** Resolved Up / Right / Out rotation (radians, variance already applied) about frame X / Y / Z. */
  adjust: V3;
}

export interface LightingContext {
  groups: readonly LightingGroup[];
  /** false = the Unify option does not exist for this generator (Batched leaf). Default true. */
  allowUnify?: boolean;
  /** false = the World up option does not exist for this generator (Batched leaf). Default true. */
  allowWorldUp?: boolean;
}

const WORLD_UP: V3 = [0, 0, 1];
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Does any option of `s` change normals? Cheap pre-check so untouched leaves skip the pass. */
export function isLightingActive(s: LeafLightingSettings, ctx?: Pick<LightingContext, 'allowUnify' | 'allowWorldUp'>): boolean {
  const unify = ctx?.allowUnify === false ? 0 : s.unify;
  const worldUp = ctx?.allowWorldUp === false ? 0 : s.worldUp;
  return (
    s.smooth > 0 ||
    (s.parentAmount > 0 && s.parentAnchor !== 'none') ||
    s.puffiness > 0 ||
    unify > 0 ||
    s.up !== 0 ||
    s.right !== 0 ||
    s.out !== 0 ||
    s.upVariance !== 0 ||
    s.rightVariance !== 0 ||
    s.outVariance !== 0 ||
    worldUp > 0
  );
}

/** Anchor moved straight up by `position x amount` metres (the position has no effect while the amount is 0). */
export function shiftAnchor(anchor: V3, position: number, amount: number): V3 {
  if (!(amount > 0)) return [anchor[0], anchor[1], anchor[2]];
  return [anchor[0], anchor[1], anchor[2] + clamp01(position) * amount];
}

/**
 * Anchor point of a leaf for the chosen style. `chain(style)` returns the ancestor point of the Global / Deep /
 * Intermediate / Local anchors (null when unknown). `height` is the Global ancestor dropped to the ground (z = 0).
 * Surface and None styles have no point. The shift is applied to every point-like anchor.
 */
export function resolveLightAnchor(
  s: Pick<LeafLightingSettings, 'parentAnchor' | 'anchorPosition' | 'anchorAmount'>,
  chain: (style: 'global' | 'deep' | 'intermediate' | 'local') => V3 | null,
  attach: V3,
): V3 | null {
  let base: V3 | null;
  switch (s.parentAnchor) {
    case 'global':
    case 'deep':
    case 'intermediate':
    case 'local':
      base = chain(s.parentAnchor);
      break;
    case 'height': {
      const g = chain('global') ?? attach;
      base = [g[0], g[1], 0];
      break;
    }
    default:
      return null;
  }
  return base ? shiftAnchor(base, s.anchorPosition, s.anchorAmount) : null;
}

/** Fixed normal direction of the Surface X / Y / Z anchors from the parent frame at the attachment (X normal, Y binormal, Z tangent). */
export function surfaceDirection(style: LeafLightingSettings['parentAnchor'], parent: { normal: V3; binormal: V3; tangent: V3 }): V3 | null {
  switch (style) {
    case 'surface-x':
      return norm(parent.normal);
    case 'surface-y':
      return norm(parent.binormal);
    case 'surface-z':
      return norm(parent.tangent);
    default:
      return null;
  }
}

/** Per-leaf Up / Right / Out rotation in radians: base value with its "±" variance from `next` (uniform 0..1, 3 draws). */
export function resolveAdjust(s: LeafLightingSettings, next: () => number): V3 {
  const pick = (value: number, variance: number): number => {
    const r = next() * 2 - 1;
    return deg2rad(variance ? value + r * variance * Math.max(Math.abs(value), 45) : value);
  };
  return [pick(s.up, s.upVariance), pick(s.right, s.rightVariance), pick(s.out, s.outVariance)];
}

/** Area-weighted face-averaged normals of one group into `out` (3 per group vertex); the old side is kept. */
function smoothedNormals(mesh: MeshData, g: LightingGroup, out: Float64Array): void {
  const pos = mesh.positions;
  const nrm = mesh.normals;
  const idx = mesh.indices;
  out.fill(0, 0, g.vertexCount * 3);
  const end = g.indexStart + g.indexCount;
  for (let t = g.indexStart; t + 2 < end; t += 3) {
    const a = (idx[t] as number) * 3;
    const b = (idx[t + 1] as number) * 3;
    const c = (idx[t + 2] as number) * 3;
    const e1x = (pos[b] as number) - (pos[a] as number);
    const e1y = (pos[b + 1] as number) - (pos[a + 1] as number);
    const e1z = (pos[b + 2] as number) - (pos[a + 2] as number);
    const e2x = (pos[c] as number) - (pos[a] as number);
    const e2y = (pos[c + 1] as number) - (pos[a + 1] as number);
    const e2z = (pos[c + 2] as number) - (pos[a + 2] as number);
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    for (let k = 0; k < 3; k++) {
      const vi = (idx[t + k] as number) - g.vertexStart;
      if (vi < 0 || vi >= g.vertexCount) continue;
      out[vi * 3] = (out[vi * 3] as number) + fx;
      out[vi * 3 + 1] = (out[vi * 3 + 1] as number) + fy;
      out[vi * 3 + 2] = (out[vi * 3 + 2] as number) + fz;
    }
  }
  // Keep the side of the original normal; vertices without faces keep the original.
  for (let i = 0; i < g.vertexCount; i++) {
    const o = (g.vertexStart + i) * 3;
    let x = out[i * 3] as number;
    let y = out[i * 3 + 1] as number;
    let z = out[i * 3 + 2] as number;
    const l = Math.hypot(x, y, z);
    if (l < 1e-18) {
      out[i * 3] = nrm[o] as number;
      out[i * 3 + 1] = nrm[o + 1] as number;
      out[i * 3 + 2] = nrm[o + 2] as number;
      continue;
    }
    x /= l;
    y /= l;
    z /= l;
    if (x * (nrm[o] as number) + y * (nrm[o + 1] as number) + z * (nrm[o + 2] as number) < 0) {
      x = -x;
      y = -y;
      z = -z;
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
}

/** Normalised blend `a + (b - a) t` written into `n[o..o+2]`; falls back to `b` when the blend collapses. */
function blendInto(n: Float64Array, o: number, bx: number, by: number, bz: number, t: number): void {
  const ax = n[o] as number;
  const ay = n[o + 1] as number;
  const az = n[o + 2] as number;
  let x = ax + (bx - ax) * t;
  let y = ay + (by - ay) * t;
  let z = az + (bz - az) * t;
  let l = Math.hypot(x, y, z);
  if (l < 1e-9) {
    x = bx;
    y = by;
    z = bz;
    l = Math.hypot(x, y, z);
  }
  if (l < 1e-12) return;
  n[o] = x / l;
  n[o + 1] = y / l;
  n[o + 2] = z / l;
}

/** Blends every normal of the group towards the unit direction from (cx, cy, cz) through its vertex. */
function blendRadial(mesh: MeshData, g: LightingGroup, n: Float64Array, cx: number, cy: number, cz: number, t: number): void {
  const pos = mesh.positions;
  for (let i = 0; i < g.vertexCount; i++) {
    const p = (g.vertexStart + i) * 3;
    const dx = (pos[p] as number) - cx;
    const dy = (pos[p + 1] as number) - cy;
    const dz = (pos[p + 2] as number) - cz;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-9) continue;
    blendInto(n, i * 3, dx / l, dy / l, dz / l, t);
  }
}

/**
 * Applies the lighting settings to the vertex normals (and tangents) of `mesh` in place, one group at a time.
 * Returns the number of groups processed. Uses typed arrays only; one scratch buffer is reused for all groups.
 */
export function applyLeafLighting(mesh: MeshData, settings: LeafLightingSettings, ctx: LightingContext): number {
  if (!isLightingActive(settings, ctx)) return 0;
  const unify = ctx.allowUnify === false ? 0 : clamp01(settings.unify);
  const worldUp = ctx.allowWorldUp === false ? 0 : clamp01(settings.worldUp);
  const smooth = clamp01(settings.smooth);
  const parentAmount = clamp01(settings.parentAmount);
  const puff = clamp01(settings.puffiness);
  let maxVerts = 0;
  for (const g of ctx.groups) maxVerts = Math.max(maxVerts, g.vertexCount);
  const n = new Float64Array(maxVerts * 3);
  const smoothed = smooth > 0 ? new Float64Array(maxVerts * 3) : null;
  const normals = mesh.normals;
  const tangents = mesh.tangents;
  const pos = mesh.positions;

  for (const g of ctx.groups) {
    const count = g.vertexCount;
    if (count <= 0) continue;
    for (let i = 0; i < count * 3; i++) n[i] = normals[g.vertexStart * 3 + i] as number;

    // 1. Smooth: original -> face-averaged normals.
    if (smoothed) {
      smoothedNormals(mesh, g, smoothed);
      for (let i = 0; i < count; i++) blendInto(n, i * 3, smoothed[i * 3] as number, smoothed[i * 3 + 1] as number, smoothed[i * 3 + 2] as number, smooth);
    }

    // 2. Parent puffiness: out from the anchor through the vertex, or along a fixed parent axis.
    if (parentAmount > 0) {
      if (g.surface) {
        for (let i = 0; i < count; i++) blendInto(n, i * 3, g.surface[0], g.surface[1], g.surface[2], parentAmount);
      } else if (g.anchor) {
        blendRadial(mesh, g, n, g.anchor[0], g.anchor[1], g.anchor[2], parentAmount);
      }
    }

    // 3. Unify: every normal of the leaf moves towards their average.
    if (unify > 0) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let i = 0; i < count; i++) {
        sx += n[i * 3] as number;
        sy += n[i * 3 + 1] as number;
        sz += n[i * 3 + 2] as number;
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 1e-9) for (let i = 0; i < count; i++) blendInto(n, i * 3, sx / l, sy / l, sz / l, unify);
    }

    // 4. Adjustments: rotate the normals (not the geometry) about the leaf's local X, Y and Z.
    if (g.adjust[0] !== 0 || g.adjust[1] !== 0 || g.adjust[2] !== 0) {
      const axes: V3[] = [g.frame.x, g.frame.y, g.frame.z];
      for (let i = 0; i < count; i++) {
        let v: V3 = [n[i * 3] as number, n[i * 3 + 1] as number, n[i * 3 + 2] as number];
        for (let a = 0; a < 3; a++) {
          const angle = g.adjust[a] as number;
          if (angle !== 0) v = rotate(v, axes[a] as V3, angle);
        }
        const nv = norm(v);
        n[i * 3] = nv[0];
        n[i * 3 + 1] = nv[1];
        n[i * 3 + 2] = nv[2];
      }
    }

    // 5. Puffiness: spherize around the centre of the leaf, after all other normal edits.
    if (puff > 0) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let i = 0; i < count; i++) {
        const p = (g.vertexStart + i) * 3;
        cx += pos[p] as number;
        cy += pos[p + 1] as number;
        cz += pos[p + 2] as number;
      }
      blendRadial(mesh, g, n, cx / count, cy / count, cz / count, puff);
    }

    // 6. World up overrides everything above.
    if (worldUp > 0) for (let i = 0; i < count; i++) blendInto(n, i * 3, WORLD_UP[0], WORLD_UP[1], WORLD_UP[2], worldUp);

    // Write back; keep tangents perpendicular to the new normals.
    for (let i = 0; i < count; i++) {
      const o = (g.vertexStart + i) * 3;
      const nx = n[i * 3] as number;
      const ny = n[i * 3 + 1] as number;
      const nz = n[i * 3 + 2] as number;
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
      if (tangents) {
        const to = (g.vertexStart + i) * 4;
        const tx = tangents[to] as number;
        const ty = tangents[to + 1] as number;
        const tz = tangents[to + 2] as number;
        const k = tx * nx + ty * ny + tz * nz;
        const ox = tx - nx * k;
        const oy = ty - ny * k;
        const oz = tz - nz * k;
        const ol = Math.hypot(ox, oy, oz);
        if (ol > 1e-6) {
          tangents[to] = ox / ol;
          tangents[to + 1] = oy / ol;
          tangents[to + 2] = oz / ol;
        }
      }
    }
  }
  return ctx.groups.length;
}
