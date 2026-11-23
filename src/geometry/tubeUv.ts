import type { Branch, Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import {
  atS,
  choosePatches,
  computeRingV,
  layoutPatches,
  resolveUTiles,
  snapRingsToWhole,
  uDensity,
  UV_DENSITY_ATTR,
  UV_TILES_ATTR,
  UV_TWIST_ATTR,
  UV_UOFFSET_ATTR,
  UV_V_ATTR,
  type PatchLayout,
  type PatchRow,
  type UvAreaLike,
  type UvMapping,
  type UvRect,
} from '@/generators/uv';
import { cross, norm, type V3 } from './math3';

/** Ring samples of one branch (the structure the tube mesher builds its rings from). */
export interface RingSamples {
  n: number;
  pos: Float32Array;
  rad: Float32Array;
  sf: Float32Array;
  s: Float32Array;
  t: Float32Array;
  tan: Float32Array;
  first: number;
}

/** Material rows + deps of the Branch / Extension material lists, resolved by the node layer. */
export interface UvMaterialOptions {
  branchRows: readonly PatchRow[];
  extensionRows: readonly PatchRow[];
  areas: readonly UvAreaLike[];
  /** Concrete material id of a material / Material Set reference (never called for `inherited`). */
  resolve(ref: string, rng: Rng): string;
}

export interface UvPlanInput {
  mapping: UvMapping;
  materials?: UvMaterialOptions;
  sk: Skeleton;
  b: Branch;
  /** Skeleton holding the branch this one grows from (attributes of the parent's mapping), null = none. */
  host: Skeleton | null;
  isExtension: boolean;
  sm: RingSamples;
  frames: V3[];
  /** Rings that belong to a weld (seams never fall inside). */
  weldRings: number;
  /** Thickest radius of the branch (reference of the U tile count and the aspect ratio). */
  rMax: number;
  metresPerTile: number;
  seed: number;
  /** Material of the node (used when a material row is empty). */
  fallbackMaterial: string;
  /** Material an `Inherited` row resolves to. */
  inheritedMaterial: string;
}

export interface UvPlan {
  sm: RingSamples;
  frames: V3[];
  uTiles: number;
  uOffset: number;
  /** Signed revolutions around the branch per V tile. */
  twist: number;
  /** V per ring (patch mode: V inside the patch). */
  vRing: Float64Array;
  /** V at an arc length (extrapolated linearly past the first / last ring). */
  vAt(s: number): number;
  /** Tiles around the parent at the attachment (parent-side UV of a welded child). */
  parentTiles(radius: number): number;
  /** V along the parent at `along` metres of `length` (parent-side UV of a welded child). */
  parentV(along: number, length: number, radius: number): number;
  /** Set in the 0-1 patch styles. */
  patch: PatchLayout | null;
  /** Material of every patch (one entry without patches). */
  materials: string[];
  rects: UvRect[];
  /** V added per metre past the tip (tip dome); 0 when the range is locked or patched. */
  tipSlope: number;
  /** True when the dome / cap must stay inside the 0..1 range. */
  confined: boolean;
}

const WHOLE: UvRect = [0, 0, 1, 1];
const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

function hostValue(host: Skeleton | null, attr: string, point: number): number | undefined {
  if (!host || point < 0 || point >= host.count) return undefined;
  const v = host.attributes.get(attr)?.[point];
  return v !== undefined && Number.isFinite(v) ? v : undefined;
}

/** Linear interpolation of a ring structure at the fractional ring `a + f` (rings are only inserted, never moved). */
function resampleRings(sm: RingSamples, frames: V3[], layout: PatchLayout): { sm: RingSamples; frames: V3[] } {
  const n = layout.count;
  const pos = new Float32Array(n * 3);
  const tan = new Float32Array(n * 3);
  const rad = new Float32Array(n);
  const sf = new Float32Array(n);
  const s = new Float32Array(n);
  const t = new Float32Array(n);
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = layout.src[k] as number;
    const f = layout.frac[k] as number;
    const b = Math.min(sm.n - 1, a + 1);
    for (let c = 0; c < 3; c++) {
      pos[k * 3 + c] = lerp(sm.pos[a * 3 + c] as number, sm.pos[b * 3 + c] as number, f);
      tan[k * 3 + c] = lerp(sm.tan[a * 3 + c] as number, sm.tan[b * 3 + c] as number, f);
    }
    rad[k] = lerp(sm.rad[a] as number, sm.rad[b] as number, f);
    sf[k] = lerp(sm.sf[a] as number, sm.sf[b] as number, f);
    s[k] = lerp(sm.s[a] as number, sm.s[b] as number, f);
    t[k] = lerp(sm.t[a] as number, sm.t[b] as number, f);
    const T = norm([tan[k * 3] as number, tan[k * 3 + 1] as number, tan[k * 3 + 2] as number], [0, 0, 1]);
    tan[k * 3] = T[0];
    tan[k * 3 + 1] = T[1];
    tan[k * 3 + 2] = T[2];
    const fa = frames[a] as V3;
    const fb = frames[b] as V3;
    let N: V3 = f === 0 ? fa : [lerp(fa[0], fb[0], f), lerp(fa[1], fb[1], f), lerp(fa[2], fb[2], f)];
    if (f !== 0) {
      // Keep the frame perpendicular to the interpolated tangent.
      const d = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
      N = norm([N[0] - T[0] * d, N[1] - T[1] * d, N[2] - T[2] * d], cross(T, [1, 0, 0]));
    }
    out.push(N);
  }
  return { sm: { n, pos, rad, sf, s, t, tan, first: sm.first }, frames: out };
}

function makeVAt(s: ArrayLike<number>, v: ArrayLike<number>): (at: number) => number {
  const n = s.length;
  return (at: number): number => {
    if (n < 2) return n === 1 ? (v[0] as number) : 0;
    if (at < (s[0] as number)) {
      const span = (s[1] as number) - (s[0] as number);
      return span > 1e-12 ? (v[0] as number) + (((v[1] as number) - (v[0] as number)) / span) * (at - (s[0] as number)) : (v[0] as number);
    }
    if (at > (s[n - 1] as number)) {
      const span = (s[n - 1] as number) - (s[n - 2] as number);
      return span > 1e-12 ? (v[n - 1] as number) + (((v[n - 1] as number) - (v[n - 2] as number)) / span) * (at - (s[n - 1] as number)) : (v[n - 1] as number);
    }
    return atS(s, v, at);
  };
}

/**
 * Everything the mesher needs to write UV0 of one branch: tile count around, offsets, twist, V per ring and (in the
 * 0-1 patch styles) the ring layout with doubled seam rings plus the material and UV Area of every patch.
 */
export function planBranchUv(inp: UvPlanInput): UvPlan {
  const m = inp.mapping;
  const point = inp.b.parentPoint;
  const rng = new Rng(inp.seed).fork('uv').fork(m.tilingSeed).fork(inp.b.id);
  const locked = m.style !== 'unrestricted';
  const patched = m.tiling !== 'tiling';
  const rows = (inp.isExtension ? inp.materials?.extensionRows : inp.materials?.branchRows) ?? [];

  // Extensions continue the mapping of the branch they extend (Extension style).
  const ext = inp.isExtension ? m.extensionStyle : 'full';
  const parentTilesValue = hostValue(inp.host, UV_TILES_ATTR, point);
  const parentVValue = hostValue(inp.host, UV_V_ATTR, point);
  const parentTwist = hostValue(inp.host, UV_TWIST_ATTR, point);
  const parentUOffset = hostValue(inp.host, UV_UOFFSET_ATTR, point);
  const known = parentTilesValue !== undefined && parentTilesValue > 0;
  const forcedTiles = known && !patched && (ext === 'automatic' || ext === 'match' || ext === 'match-u') ? parentTilesValue : undefined;
  const circumference = 2 * Math.PI * inp.rMax;
  let baseRadius = 0;
  for (let k = inp.sm.first; k < inp.sm.n; k++) baseRadius = Math.max(baseRadius, inp.sm.rad[k] as number);
  const autoCircumference = 2 * Math.PI * (baseRadius > 0 ? baseRadius : inp.rMax);
  const uTiles = patched
    ? 1
    : resolveUTiles({
        style: m.style,
        absolute: m.uAbsolute,
        relative: m.uRelative,
        fractional: m.fractional,
        circumference,
        autoCircumference,
        metresPerTile: inp.metresPerTile,
        ...(hostValue(inp.host, UV_DENSITY_ATTR, point) !== undefined ? { parentDensity: hostValue(inp.host, UV_DENSITY_ATTR, point) as number } : {}),
        ...(forcedTiles !== undefined ? { forcedTiles } : {}),
      });
  const free = !locked && !patched;
  const followParent = ext === 'automatic' && known;
  const uOffset = !free ? 0 : followParent && parentUOffset !== undefined ? parentUOffset : sampleVariance(rng.fork('uo'), m.uOffset, m.uOffsetVariance, uTiles);
  const flip = m.twistRandomFlip ? rng.fork('flip').sign() : 1;
  const twist = !free ? 0 : followParent && parentTwist !== undefined ? parentTwist : m.twist * flip;

  // V per ring.
  const style = m.style === 'uv-locked' ? 'relative' : m.vStyle;
  const continued = inp.isExtension && parentVValue !== undefined && (ext === 'automatic' || ext === 'match');
  const sampledOffset = sampleVariance(rng.fork('vo'), m.vOffset, m.vOffsetVariance, 1);
  const offset = locked || patched ? 0 : continued ? (parentVValue as number) : sampledOffset;
  let v = computeRingV({
    style,
    anchor: m.style === 'uv-locked' || continued ? 'start' : m.vAnchor,
    scale: m.style === 'uv-locked' ? 1 : m.vScale,
    skew: m.skew,
    pinch: m.pinch,
    offset,
    uTiles: patched ? 1 : uTiles,
    metresPerTile: inp.metresPerTile,
    s: inp.sm.s,
    radius: inp.sm.rad,
    refRadius: Math.max(1e-6, inp.rMax),
  });
  if (m.optimizeSegments && !patched && !locked) v = snapRingsToWhole(v, m.vTolerance);

  const parentTiles = (radius: number): number =>
    known
      ? (parentTilesValue as number)
      : resolveUTiles({ style: 'unrestricted', absolute: m.uAbsolute, relative: m.uRelative, fractional: m.fractional, circumference: 2 * Math.PI * radius, metresPerTile: inp.metresPerTile });
  const parentV = (along: number, length: number, radius: number): number => {
    if (m.vStyle === 'relative') return (along / Math.max(1e-6, length)) * m.vScale + m.vOffset;
    if (m.vStyle === 'aspect') return (along * m.vScale * parentTiles(radius)) / (2 * Math.PI * Math.max(1e-6, radius)) + m.vOffset;
    return (along * m.vScale) / Math.max(1e-4, inp.metresPerTile) + m.vOffset;
  };

  let sm = inp.sm;
  let frames = inp.frames;
  let layout: PatchLayout | null = null;
  const fallback = inp.fallbackMaterial;
  const resolveRef = (ref: string, r: Rng): string => {
    if (ref === 'inherited') return inp.inheritedMaterial || fallback;
    return (ref && inp.materials ? inp.materials.resolve(ref, r) : '') || fallback;
  };
  const areas = inp.materials?.areas ?? [];
  const sPre = inp.sm.s;
  const vPre = v;
  let vRing = v;
  let choice = { materials: [fallback], rects: [WHOLE] as UvRect[] };
  if (patched && inp.sm.n >= 2) {
    layout = layoutPatches({ v, optimize: m.optimizeSegments, tolerance: Math.min(0.5, Math.max(0, m.vTolerance)), firstFree: inp.weldRings });
    const res = resampleRings(sm, frames, layout);
    sm = res.sm;
    frames = res.frames;
    vRing = Float64Array.from(layout.localV);
    choice = choosePatches(m.tiling, rows, layout.patches, rng.fork('patch'), { resolveMaterial: resolveRef, areas });
  } else if (inp.materials) {
    choice = choosePatches('tiling', rows, 1, rng.fork('patch'), { resolveMaterial: resolveRef, areas });
  }
  const preAt = makeVAt(sPre, vPre);
  const confined = locked || patched;
  const n = sPre.length;
  const tipSpan = n >= 2 ? (sPre[n - 1] as number) - (sPre[n - 2] as number) : 0;
  const tipSlope = confined || tipSpan <= 1e-12 ? 0 : ((vPre[n - 1] as number) - (vPre[n - 2] as number)) / tipSpan;
  return {
    sm,
    frames,
    uTiles,
    uOffset,
    twist,
    vRing,
    vAt: patched ? (s: number): number => Math.min(1, Math.max(0, preAt(s))) : preAt,
    parentTiles,
    parentV,
    patch: layout,
    materials: choice.materials,
    rects: choice.rects,
    tipSlope,
    confined,
  };
}

/**
 * Stores the mapping of a branch on its skeleton points (tiles around, texel density, V, twist, U offset) so children,
 * extensions and Fractional > Auto can follow it.
 */
export function writeUvAttributes(sk: Skeleton, b: Branch, plan: UvPlan): void {
  const slot = (name: string): Float32Array => {
    let a = sk.attributes.get(name);
    if (!a || a.length !== sk.count) {
      a = new Float32Array(sk.count);
      sk.attributes.set(name, a);
    }
    return a;
  };
  const tiles = slot(UV_TILES_ATTR);
  const density = slot(UV_DENSITY_ATTR);
  const twist = slot(UV_TWIST_ATTR);
  const uoff = slot(UV_UOFFSET_ATTR);
  const vv = slot(UV_V_ATTR);
  const { sm } = plan;
  let r = 0;
  for (let k = 0; k < b.count; k++) {
    const g = b.start + k;
    tiles[g] = plan.uTiles;
    density[g] = uDensity(plan.uTiles, sk.radius[g] as number);
    twist[g] = plan.twist;
    uoff[g] = plan.uOffset;
    if (plan.patch || sm.n < 2) continue;
    while (r < sm.n - 2 && (sm.sf[r + 1] as number) <= k) r++;
    const span = (sm.sf[r + 1] as number) - (sm.sf[r] as number);
    const f = span > 1e-9 ? Math.min(1, Math.max(0, (k - (sm.sf[r] as number)) / span)) : 0;
    vv[g] = lerp(plan.vRing[r] as number, plan.vRing[r + 1] as number, f);
  }
}
