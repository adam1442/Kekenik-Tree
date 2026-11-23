import { getNumber, getString, type NodeParams, type ParamState } from '@/contracts/params';
import { clamp, deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import type { KnotNoise, KnotSegmentSettings, KnotShape, KnotUv, KnotUvStyle } from '@/generators/knot';
import { MATERIAL_INHERITED, WHOLE_MAP, type PatchRow, type UvRect } from '@/generators/uv';
import { DEFAULT_ROW, rowsOf } from './uvConfig';

/** A parameter value with its "±" variance (fraction of the value). */
interface Varied {
  value: number;
  variance: number;
}

const varied = (p: NodeParams, id: string, fallback: number): Varied => ({ value: getNumber(p, id, fallback), variance: p[id]?.variance ?? 0 });

interface UvSettings {
  style: KnotUvStyle;
  scale: number;
  offsetU: number;
  offsetV: number;
}

/** Everything the Knot node reads from its parameters (the per-knot random draws are made by `sampleKnotShape`). */
export interface KnotConfig {
  size: Varied;
  offset: Varied;
  rotation: Varied;
  width: Varied;
  lip: Varied;
  outerShape: KnotNoise;
  outerOffset: KnotNoise;
  noiseSeed: number;
  innerSizePct: Varied;
  innerScale: Varied;
  innerCurvature: Varied;
  innerOverlap: number;
  innerUv: UvSettings;
  innerShape: KnotNoise;
  coreSizePct: Varied;
  coreOffset: Varied;
  coreUv: UvSettings;
  coreShape: KnotNoise;
  coreOffsetNoise: KnotNoise;
  innerRows: PatchRow[];
  coreRows: PatchRow[];
  segments: KnotSegmentSettings;
  lodWeight: number;
}

const noise = (p: NodeParams, amountId: string, scaleId: string, amount: number, scale: number): KnotNoise => ({
  amount: Math.max(0, getNumber(p, amountId, amount)),
  scale: Math.max(0.01, getNumber(p, scaleId, scale)),
});

const uvOf = (p: NodeParams, prefix: 'inner' | 'core'): UvSettings => ({
  style: getString(p, `${prefix}UvStyle`, 'match-trunk') === 'ring' ? 'ring' : 'match-trunk',
  scale: Math.max(0.01, getNumber(p, `${prefix}UvScale`, 1)),
  offsetU: getNumber(p, `${prefix}UvOffsetU`, 0),
  offsetV: getNumber(p, `${prefix}UvOffsetV`, 0),
});

export function readKnotConfig(p: NodeParams): KnotConfig {
  return {
    size: varied(p, 'outerSize', 0.12),
    offset: varied(p, 'outerOffset', 0.02),
    rotation: varied(p, 'outerRotation', 0),
    width: varied(p, 'outerScale', 1),
    lip: varied(p, 'outerLip', 0.01),
    outerShape: noise(p, 'outerShapeAmount', 'outerShapeScale', 0.15, 2),
    outerOffset: noise(p, 'outerOffsetAmount', 'outerOffsetScale', 0.004, 4),
    noiseSeed: Math.round(getNumber(p, 'outerNoiseSeed', 0)),
    innerSizePct: varied(p, 'innerSizePct', 60),
    innerScale: varied(p, 'innerScale', 1),
    innerCurvature: varied(p, 'innerCurvature', 0.5),
    innerOverlap: clamp(getNumber(p, 'innerOverlap', 0), 0, 0.9),
    innerUv: uvOf(p, 'inner'),
    innerShape: noise(p, 'innerShapeAmount', 'innerShapeScale', 0.1, 2),
    coreSizePct: varied(p, 'coreSizePct', 50),
    coreOffset: varied(p, 'coreOffset', -0.01),
    coreUv: uvOf(p, 'core'),
    coreShape: noise(p, 'coreShapeAmount', 'coreShapeScale', 0.1, 2),
    coreOffsetNoise: noise(p, 'coreOffsetAmount', 'coreOffsetScale', 0.003, 4),
    innerRows: rowsOf(p.innerMaterials?.value, DEFAULT_ROW(MATERIAL_INHERITED)),
    coreRows: rowsOf(p.coreMaterials?.value, DEFAULT_ROW('')),
    segments: {
      ringsOuter: Math.round(getNumber(p, 'ringsOuter', 3)),
      ringsInner: Math.round(getNumber(p, 'ringsInner', 3)),
      ringsCore: Math.round(getNumber(p, 'ringsCore', 2)),
      slices: Math.round(getNumber(p, 'slices', 16)),
      resolution: getNumber(p, 'knotResolution', 1),
      lodRings: clamp(getNumber(p, 'lodRingSegments', 0.5), 0, 1),
      lodSlices: clamp(getNumber(p, 'lodSliceSegments', 0.5), 0, 1),
    },
    lodWeight: clamp(getNumber(p, 'lodWeight', 1), 0, 1),
  };
}

const isWhole = (r: UvRect): boolean => r[0] === WHOLE_MAP[0] && r[1] === WHOLE_MAP[1] && r[2] === WHOLE_MAP[2] && r[3] === WHOLE_MAP[3];

/** Material rectangle -> `KnotUv.rect` (null = whole map, tiles freely). */
export const rectOrNull = (r: UvRect | undefined): UvRect | null => (r && !isWhole(r) ? r : null);

/**
 * Samples every per-knot value with its variance. Each parameter has its own RNG stream (`rng.fork(id)`), so adding a
 * parameter never shifts the others; same graph + seed = same knot.
 */
export function sampleKnotShape(cfg: KnotConfig, rng: Rng, innerRect: UvRect | null, coreRect: UvRect | null): KnotShape {
  const v = (id: string, a: Varied, span?: number): number => sampleVariance(rng.fork(id), a.value, a.variance, span);
  const size = Math.max(0.002, v('size', cfg.size));
  const ref = Math.max(0.01, size * 0.5);
  const sizePct = (id: string, a: Varied): number => clamp(v(id, a), 5, 98) / 100;
  const uv = (u: UvSettings, rect: UvRect | null): KnotUv => ({ style: u.style, scale: u.scale, offsetU: u.offsetU, offsetV: u.offsetV, rect });
  return {
    size,
    offset: v('offset', cfg.offset, Math.max(Math.abs(cfg.offset.value), ref)),
    rotation: deg2rad(v('rotation', cfg.rotation, 180)),
    width: clamp(v('width', cfg.width), 0.1, 8),
    lip: v('lip', cfg.lip, Math.max(Math.abs(cfg.lip.value), ref * 0.5)),
    outerShape: cfg.outerShape,
    outerOffset: cfg.outerOffset,
    inner: {
      sizeFrac: sizePct('innerSize', cfg.innerSizePct),
      scale: clamp(v('innerScale', cfg.innerScale), 0.1, 4),
      curvature: v('curvature', cfg.innerCurvature, Math.max(Math.abs(cfg.innerCurvature.value), 0.5)),
      overlap: cfg.innerOverlap,
      uv: uv(cfg.innerUv, innerRect),
      shape: cfg.innerShape,
    },
    core: {
      sizeFrac: sizePct('coreSize', cfg.coreSizePct),
      offset: v('coreOffset', cfg.coreOffset, Math.max(Math.abs(cfg.coreOffset.value), ref * 0.5)),
      uv: uv(cfg.coreUv, coreRect),
      shape: cfg.coreShape,
      offsetNoise: cfg.coreOffsetNoise,
    },
  };
}

/** Typical branch radius the old (relative) Outer size was measured against, used to convert saved projects. */
const LEGACY_REFERENCE_RADIUS = 0.1;

const numberOf = (p: NodeParams, id: string): number | undefined => (typeof p[id]?.value === 'number' ? (p[id]?.value as number) : undefined);

/**
 * Projects saved with the old skeleton-stub Knot (`knotRadius` = fraction of the parent radius, `knotLength`, `knotCoreScale`,
 * `knotCurvature`, `material`) become the new parameters: Size = fraction x 0.1 m, Offset = a quarter of the old extrusion,
 * Inner Size % = the old core scale, Curvature kept, the old material becomes the Inner and Core material. Idempotent.
 */
export function migrateKnotParams(params: NodeParams): NodeParams {
  if (!('knotRadius' in params || 'knotLength' in params || 'knotCoreScale' in params || 'knotCurvature' in params)) return params;
  const out: NodeParams = { ...params };
  const carry = (id: string, value: number, from: ParamState | undefined): void => {
    if (out[id] === undefined) out[id] = { value, ...(from?.variance !== undefined ? { variance: from.variance } : {}) };
  };
  const radius = numberOf(params, 'knotRadius');
  if (radius !== undefined) carry('outerSize', clamp(radius * LEGACY_REFERENCE_RADIUS, 0.002, 20), params.knotRadius);
  const length = numberOf(params, 'knotLength');
  if (length !== undefined) carry('outerOffset', length * 0.25, params.knotLength);
  const core = numberOf(params, 'knotCoreScale');
  if (core !== undefined) carry('innerSizePct', clamp(core * 100, 5, 98), undefined);
  const curv = numberOf(params, 'knotCurvature');
  if (curv !== undefined) carry('innerCurvature', curv * 2, undefined);
  const material = typeof params.material?.value === 'string' ? params.material.value : '';
  if (material && out.innerMaterials === undefined) {
    const row = { material, weight: 1, uvArea: 'whole' };
    out.innerMaterials = { value: [row] };
    out.coreMaterials = { value: [{ ...row }] };
  }
  for (const id of ['knotRadius', 'knotLength', 'knotCoreScale', 'knotCurvature', 'spread', 'segments', 'material']) delete out[id];
  return out;
}
