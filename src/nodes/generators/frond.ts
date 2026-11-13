import { getBool, getNumber, getString, type NodeParams, type ParamState } from '@/contracts/params';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import type { MeshData } from '@/contracts/mesh';
import { evaluateCurve, type Curve } from '@/contracts/curve';
import { SkeletonBuilder, type Branch, type Skeleton } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { composeMatrix } from '@/geometry/instancing';
import { cross, norm, rotate, type V3 } from '@/geometry/math3';
import {
  buildRibbonFrames,
  buildRibbonFromFrames,
  buildRibbonMesh,
  framesMatch,
  ribbonBasis,
  toLocalFrames,
  type RibbonOptions,
  type RibbonShape,
  type RibbonSpec,
  type TipShape,
} from '@/geometry/ribbonMesher';
import { resolveUvAreaRect } from '@/materials/materialSource';
import { displaceFromParams, resolveDisplacement } from './displacement';
import { atlasRect, emptyFoliage, foliageOutput, isActive, parentOf, parentWind, pickLeafType, leafTint, postTransform, varied } from './foliageCommon';

/** Safety cap on ribbons (before `planes per spine`). */
export const MAX_RIBBONS = 60_000;

const curveOf = (p: NodeParams, id: string): Curve | undefined => (p[id]?.curve ?? undefined) as Curve | undefined;
const curveFn = (c: Curve | undefined): ((t: number) => number) | undefined => (c ? (t) => evaluateCurve(c, t) : undefined);

/** Sub-polyline of `pts` between arc-length fractions f0..f1 (interpolated end points). */
export function trimPolyline(pts: V3[], f0: number, f1: number): V3[] {
  if (pts.length < 2) return pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as V3;
    const b = pts[i] as V3;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[cum.length - 1] as number;
  const s0 = Math.min(1, Math.max(0, f0)) * total;
  const s1 = Math.min(1, Math.max(0, f1)) * total;
  if (s1 - s0 < 1e-9) return [];
  const at = (s: number): V3 => {
    let i = 1;
    while (i < pts.length - 1 && (cum[i] as number) < s) i++;
    const span = (cum[i] as number) - (cum[i - 1] as number);
    const f = span > 1e-12 ? (s - (cum[i - 1] as number)) / span : 0;
    const a = pts[i - 1] as V3;
    const b = pts[i] as V3;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  const out: V3[] = [at(s0)];
  for (let i = 1; i < pts.length - 1; i++) if ((cum[i] as number) > s0 && (cum[i] as number) < s1) out.push(pts[i] as V3);
  out.push(at(s1));
  return out;
}

export function polyLength(pts: readonly V3[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as V3;
    const b = pts[i] as V3;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

/** Moves the end of a polyline along its last direction by `delta` metres (negative shortens it). */
export function extendPolyline(pts: V3[], delta: number): V3[] {
  if (pts.length < 2 || delta === 0) return pts;
  if (delta < 0) {
    const total = polyLength(pts);
    return trimPolyline(pts, 0, Math.max(0.02, (total + delta) / Math.max(1e-9, total)));
  }
  const a = pts[pts.length - 2] as V3;
  const b = pts[pts.length - 1] as V3;
  const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  return [...pts, [b[0] + d[0] * delta, b[1] + d[1] * delta, b[2] + d[2] * delta]];
}

function branchPoints(sk: Skeleton, b: Branch): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < b.count; k++) {
    const q = (b.start + k) * 3;
    out.push([sk.position[q] as number, sk.position[q + 1] as number, sk.position[q + 2] as number]);
  }
  return out;
}

/** Initial face direction for the Facing option. */
function facingHint(mode: string, sk: Skeleton, b: Branch, pts: V3[], rng: Rng): V3 {
  switch (mode) {
    case 'outward': {
      const o = pts[0] as V3;
      return Math.hypot(o[0], o[1]) > 1e-4 ? norm([o[0], o[1], 0]) : norm([rng.range(-1, 1), rng.range(-1, 1), 0], [1, 0, 0]);
    }
    case 'parent-roll': {
      const nx = sk.attributes.get('rmfNormalX');
      const ny = sk.attributes.get('rmfNormalY');
      const nz = sk.attributes.get('rmfNormalZ');
      if (nx && ny && nz) return [nx[b.start] as number, ny[b.start] as number, nz[b.start] as number];
      return norm(cross([0, 0, 1], [1e-3, 1, 0]));
    }
    case 'random':
      return norm([rng.range(-1, 1), rng.range(-1, 1), rng.range(-0.2, 1)], [0, 0, 1]);
    default:
      return [0, 0, 1];
  }
}

/** Options for the ribbon mesher from the Skin / UV / LOD / Displacement tabs. */
export function ribbonOptionsFromParams(p: NodeParams, lod: number, meanLength: number): RibbonOptions {
  const keep = Math.pow(1 - Math.min(0.9, Math.max(0, getNumber(p, 'lodSegments', 0.5))) * 0.4, Math.min(Math.max(lod, 0), 3));
  let lengthSegments = Math.max(1, Math.round(getNumber(p, 'frondLengthSegments', 6) * keep));
  let widthSegments = Math.max(1, Math.min(8, Math.round(getNumber(p, 'frondWidthSegments', 1))));
  if (getBool(p, 'displaceAutoSubdivide', true) && resolveDisplacement(p).state === 'ready' && getNumber(p, 'displaceAmount', 0) !== 0) {
    const detail = Math.max(0.002, getNumber(p, 'displaceDetail', 0.03));
    widthSegments = Math.min(8, Math.max(widthSegments, 6));
    lengthSegments = Math.min(64, Math.max(lengthSegments, Math.ceil(meanLength / detail)));
  }
  return {
    lengthSegments,
    adaptive: getBool(p, 'frondAdaptive', true),
    widthSegments,
    duplicateBackFaces: getString(p, 'frondFaces', 'material') === 'duplicate-back-faces',
    uvMode: getString(p, 'frondUvMode', 'stretch') === 'tile' ? 'tile' : 'stretch',
    uvTile: getNumber(p, 'frondUvTile', 1),
    uvScaleU: getNumber(p, 'frondUvScaleU', 1),
    uvScaleV: getNumber(p, 'frondUvScaleV', 1),
    uvOffsetU: getNumber(p, 'frondUvOffsetU', 0),
    uvOffsetV: getNumber(p, 'frondUvOffsetV', 0),
    defaultMaterial: 'leaf',
  };
}

const SHAPES: Record<string, RibbonShape> = { flat: 'flat', 'v-fold': 'vfold', 'u-curve': 'ucurve' };
const TIPS: Record<string, TipShape> = { pointed: 'pointed', rounded: 'rounded', blunt: 'blunt' };

/** Ribbon specs of every parent spine (planes per spine included). Exported for tests. */
export function buildFrondSpecs(ctx: NodeContext, parent: Skeleton, p: NodeParams): { specs: RibbonSpec[]; spineOf: number[] } {
  const post = postTransform(p);
  const planes = Math.max(1, Math.min(8, Math.round(getNumber(p, 'frondPlanes', 1))));
  const f0 = getNumber(p, 'first', 0);
  const f1 = Math.max(f0, getNumber(p, 'last', 1));
  const lodT = Math.min(Math.max(ctx.lod, 0), 3) / 3;
  const cull = getNumber(p, 'lodCull', 0) * lodT;
  const boost = 1 + (cull > 0 ? (1 / Math.max(0.2, 1 - cull) - 1) * getNumber(p, 'lodWidthBoost', 0.5) : 0);
  const shape = SHAPES[getString(p, 'frondShape', 'flat')] ?? 'flat';
  const tip = TIPS[getString(p, 'frondTipShape', 'pointed')] ?? 'pointed';
  const facing = getString(p, 'frondFacing', 'up');
  const widthCurve = curveFn(curveOf(p, 'frondWidth'));
  const foldCurve = curveFn(curveOf(p, 'frondFoldAngle'));
  const lengthCurve = curveOf(p, 'frondLengthScale');
  const windPower = getNumber(p, 'frondBendPower', 1.5);
  const specs: RibbonSpec[] = [];
  const spineOf: number[] = [];
  let index = 0;
  for (const b of parent.branches) {
    if (b.count < 2) continue;
    if (specs.length >= MAX_RIBBONS) break;
    ctx.cancel.throwIfCancelled();
    const rng = ctx.rng.fork(`fr:${b.id}`);
    // Draws are always consumed in the same order, so LOD changes never reshuffle the other blades.
    const cullDraw = rng.next();
    if (cullDraw < cull) continue;
    let pts = branchPoints(parent, b);
    pts = trimPolyline(pts, f0, f1);
    if (pts.length < 2) continue;
    const u = b.parentPoint >= 0 && parent.count > 0 ? ((parent.t[Math.min(parent.count - 1, b.parentPoint)] as number) ?? 0) : 0;
    const scale = Math.max(0.01, varied(rng, p, 'frondLengthScale', 1) * (lengthCurve ? evaluateCurve(lengthCurve, u) : 1) * post.scale);
    const total = polyLength(pts);
    pts = extendPolyline(pts, total * (scale - 1) + getNumber(p, 'frondLengthAdd', 0));
    if (pts.length < 2) continue;
    const width = varied(rng, p, 'frondWidth', 0.25) * boost * post.scale;
    const droop = varied(rng, p, 'frondDroop', 0.3);
    const arch = deg2rad(varied(rng, p, 'frondArch', 0));
    const twist = deg2rad(varied(rng, p, 'frondTwist', 0));
    const roll = deg2rad(varied(rng, p, 'frondRoll', 0));
    const hint = facingHint(facing, parent, b, pts, rng);
    const type = pickLeafType(rng, p, 'leaf');
    const atlas = resolveUvAreaRect(type.material, 'frond', rng) ?? atlasRect(p, rng, index);
    const color = leafTint(rng, p);
    const wind = parentWind(parent, b.start, index * 31 + 7);
    const off = post.offset;
    const moved = off[0] !== 0 || off[1] !== 0 || off[2] !== 0 ? pts.map((q): V3 => [q[0] + off[0], q[1] + off[1], q[2] + off[2]]) : pts;
    for (let k = 0; k < planes; k++) {
      const planeAngle = deg2rad(getNumber(p, 'frondStartAngle', 0)) + (k * Math.PI) / planes + post.roll;
      const t0 = norm([moved[1]![0] - moved[0]![0], moved[1]![1] - moved[0]![1], moved[1]![2] - moved[0]![2]]);
      specs.push({
        path: moved,
        normalHint: rotate(hint, t0, planeAngle),
        width,
        ...(widthCurve ? { widthAt: widthCurve } : {}),
        baseWidth: getNumber(p, 'frondBaseWidth', 1),
        tipShape: tip,
        tipTaper: getNumber(p, 'frondTipTaper', 0.35),
        shape,
        foldAngle: deg2rad(getNumber(p, 'frondFoldAngle', 40)),
        ...(foldCurve ? { foldAt: foldCurve } : {}),
        curl: getNumber(p, 'frondCurl', 0),
        crease: deg2rad(getNumber(p, 'frondCrease', 0)),
        roll,
        twist,
        droop,
        arch,
        offset: getNumber(p, 'frondOffset', 0),
        color,
        colorGradient: getNumber(p, 'vertexColorGradient', 0),
        ao: getNumber(p, 'aoStrength', 0.5),
        atlas,
        materialId: type.material,
        wind,
        windPower,
      });
      spineOf.push(b.id);
    }
    index++;
  }
  return { specs, spineOf };
}

const SCALAR_KEYS = ['width', 'baseWidth', 'tipTaper', 'foldAngle', 'curl', 'crease', 'roll', 'twist', 'droop', 'arch', 'offset'] as const;

/** If every blade has exactly the same local shape, returns the instanced mesh (one geometry + matrices). */
export function tryInstance(specs: readonly RibbonSpec[], opts: RibbonOptions): MeshData | null {
  if (specs.length < 2) return null;
  const first = specs[0] as RibbonSpec;
  for (const s of specs) {
    if (s.shape !== first.shape || s.tipShape !== first.tipShape || s.materialId !== first.materialId) return null;
    if (s.atlas.some((v, i) => v !== first.atlas[i])) return null;
    for (const k of SCALAR_KEYS) if (Math.abs(s[k] - first[k]) > 1e-9) return null;
  }
  const f0 = buildRibbonFrames(first, opts);
  if (!f0) return null;
  const b0 = ribbonBasis(f0);
  const local0 = toLocalFrames(f0, b0);
  const matrices = new Float32Array(specs.length * 16);
  for (let k = 0; k < specs.length; k++) {
    const fk = k === 0 ? f0 : buildRibbonFrames(specs[k] as RibbonSpec, opts);
    if (!fk) return null;
    const bk = ribbonBasis(fk);
    if (k > 0 && !framesMatch(local0, toLocalFrames(fk, bk), 1e-4 * Math.max(0.1, f0.length))) return null;
    composeMatrix(bk.origin, bk.x, bk.y, bk.z, 1, matrices, k * 16);
  }
  const base = buildRibbonFromFrames(first, local0, opts);
  return { ...base, instanced: { count: specs.length, matrices } };
}

export function evaluateFrond(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const { specs } = buildFrondSpecs(ctx, parent, p);
  if (specs.length === 0) return emptyFoliage(parent, ctx.seed);
  let meanLength = 0;
  for (const s of specs) meanLength += polyLength(s.path);
  meanLength /= specs.length;
  const opts = ribbonOptionsFromParams(p, ctx.lod, meanLength);
  const displaced = resolveDisplacement(p).state === 'ready' && getNumber(p, 'displaceAmount', 0) !== 0;
  const instanced = !displaced && getBool(p, 'frondInstancing', true) ? tryInstance(specs, opts) : null;
  let mesh: MeshData;
  let frames;
  if (instanced) {
    mesh = instanced;
    frames = specs.map((s) => buildRibbonFrames(s, opts));
  } else {
    const built = buildRibbonMesh(specs, opts);
    mesh = displaceFromParams(built.mesh, p, ctx.lod);
    frames = built.frames;
  }
  // One centre-line branch per ribbon (first plane of every spine) for overlays and child inheritance.
  const planes = Math.max(1, Math.min(8, Math.round(getNumber(p, 'frondPlanes', 1))));
  const sb = new SkeletonBuilder();
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  let count = 0;
  for (let i = 0; i < frames.length; i += planes) {
    const fr = frames[i];
    if (!fr) continue;
    sb.beginBranch(-1, -1, gen);
    fr.points.forEach((pt) => sb.addPoint(pt[0], pt[1], pt[2], 0.001));
    sb.endBranch();
    count++;
  }
  const sk = sb.build();
  return foliageOutput(sk, parent, mesh, count, ctx.seed);
}

/** Old (pinnae-style) Frond params -> ribbon params. Unknown / obsolete ids are dropped. */
export function migrateFrondParams(params: NodeParams, fromVersion: number): NodeParams {
  if (fromVersion >= 2) return params;
  const out: NodeParams = { ...params };
  const num = (id: string): number | undefined => (typeof params[id]?.value === 'number' ? (params[id]?.value as number) : undefined);
  const set = (id: string, state: ParamState): void => {
    out[id] = state;
  };
  const pinnaLen = num('frondPinnaLength');
  if (pinnaLen !== undefined) set('frondWidth', { value: Math.min(50, pinnaLen * 1.4), ...(params.frondPinnaLength?.variance !== undefined ? { variance: params.frondPinnaLength.variance } : {}) });
  const taper = num('frondTaper');
  if (taper !== undefined) set('frondTipTaper', { value: Math.min(1, 0.25 + taper * 0.5) });
  const droop = num('frondDroop');
  if (droop !== undefined) set('frondDroop', { value: droop });
  const arch = num('frondCurl');
  if (arch !== undefined) set('frondArch', { value: arch * 45 });
  const twist = num('frondTwist');
  if (twist !== undefined) set('frondTwist', { value: twist * 90 });
  const segs = num('frondSegments');
  if (segs !== undefined) set('frondLengthSegments', { value: Math.min(24, Math.max(2, Math.round(segs))) });
  const rachis = num('frondLength');
  if (rachis !== undefined) set('frondLengthScale', { value: 1 });
  // Obsolete: the number / boundaries of the old distribution, pinnae and rachis settings.
  for (const id of ['number', 'first', 'last', 'mode', 'frondRachisRadius', 'frondFins', 'frondStart', 'frondPinnaLength', 'frondPinnaWidth', 'frondPinnaAngle', 'frondPinnaDroop', 'frondPinnaSegments', 'frondSizeCurve', 'frondLength']) delete out[id];
  return out;
}
