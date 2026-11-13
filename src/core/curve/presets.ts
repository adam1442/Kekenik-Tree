import type { Curve, CurvePoint } from './types';

/**
 * Built-in curve presets.
 */

export type CurvePresetId =
  | 'linear'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | 'bell'
  | 'inverse'
  | 'constant-1'
  | 'constant-0.5'
  | 'constant-0'
  | 'step'
  | 'noise'
  | 'late-rise'
  | 'early-drop'
  | 'spike';

export interface CurvePresetDef {
  id: CurvePresetId;
  label: string;
  /** Normalized points in [0, 1] x [0, 1] domain. */
  buildNormalized(): CurvePoint[];
}

export const CURVE_PRESETS: readonly CurvePresetDef[] = [
  {
    id: 'linear',
    label: 'Linear',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.333, dy: -0.333 }, outTangent: { dx: 0.333, dy: 0.333 }, mode: 'linear' },
      { x: 1, y: 1, inTangent: { dx: -0.333, dy: -0.333 }, outTangent: { dx: 0.333, dy: 0.333 }, mode: 'linear' },
    ],
  },
  {
    id: 'ease-in',
    label: 'Ease In',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.35, dy: 0 }, mode: 'flat' },
      { x: 1, y: 1, inTangent: { dx: -0.35, dy: -0.7 }, outTangent: { dx: 0.35, dy: 0.7 }, mode: 'aligned' },
    ],
  },
  {
    id: 'ease-out',
    label: 'Ease Out',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.35, dy: -0.7 }, outTangent: { dx: 0.35, dy: 0.7 }, mode: 'aligned' },
      { x: 1, y: 1, inTangent: { dx: -0.35, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'flat' },
    ],
  },
  {
    id: 'ease-in-out',
    label: 'Ease In-Out',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.35, dy: 0 }, mode: 'flat' },
      { x: 1, y: 1, inTangent: { dx: -0.35, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'flat' },
    ],
  },
  {
    id: 'bell',
    label: 'Bell / Hump',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'flat' },
      { x: 0.5, y: 1, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'flat' },
      { x: 1, y: 0, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'flat' },
    ],
  },
  {
    id: 'inverse',
    label: 'Inverse',
    buildNormalized: () => [
      { x: 0, y: 1, inTangent: { dx: -0.333, dy: 0.333 }, outTangent: { dx: 0.333, dy: -0.333 }, mode: 'linear' },
      { x: 1, y: 0, inTangent: { dx: -0.333, dy: 0.333 }, outTangent: { dx: 0.333, dy: -0.333 }, mode: 'linear' },
    ],
  },
  {
    id: 'constant-1',
    label: 'Constant 1',
    buildNormalized: () => [
      { x: 0, y: 1, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'linear' },
      { x: 1, y: 1, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'linear' },
    ],
  },
  {
    id: 'constant-0.5',
    label: 'Constant 0.5',
    buildNormalized: () => [
      { x: 0, y: 0.5, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'linear' },
      { x: 1, y: 0.5, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'linear' },
    ],
  },
  {
    id: 'constant-0',
    label: 'Constant 0',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'linear' },
      { x: 1, y: 0, inTangent: { dx: -0.333, dy: 0 }, outTangent: { dx: 0.333, dy: 0 }, mode: 'linear' },
    ],
  },
  {
    id: 'step',
    label: 'Step',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'stepped' },
      { x: 0.5, y: 1, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'stepped' },
      { x: 1, y: 1, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'stepped' },
    ],
  },
  {
    id: 'noise',
    label: 'Noise-like',
    buildNormalized: () => [
      { x: 0, y: 0.35, inTangent: { dx: -0.08, dy: 0 }, outTangent: { dx: 0.08, dy: 0.12 }, mode: 'auto' },
      { x: 0.2, y: 0.82, inTangent: { dx: -0.07, dy: 0 }, outTangent: { dx: 0.07, dy: 0 }, mode: 'auto' },
      { x: 0.42, y: 0.18, inTangent: { dx: -0.07, dy: 0 }, outTangent: { dx: 0.07, dy: 0 }, mode: 'auto' },
      { x: 0.65, y: 0.91, inTangent: { dx: -0.07, dy: 0 }, outTangent: { dx: 0.07, dy: 0 }, mode: 'auto' },
      { x: 0.84, y: 0.32, inTangent: { dx: -0.07, dy: 0 }, outTangent: { dx: 0.07, dy: 0 }, mode: 'auto' },
      { x: 1, y: 0.68, inTangent: { dx: -0.08, dy: 0.08 }, outTangent: { dx: 0.08, dy: 0 }, mode: 'auto' },
    ],
  },
  {
    id: 'late-rise',
    label: 'Late Rise',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'linear' },
      { x: 0.683, y: 0, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.1, dy: 0.315 }, mode: 'linear' },
      { x: 1, y: 1, inTangent: { dx: -0.1, dy: -0.315 }, outTangent: { dx: 0.1, dy: 0 }, mode: 'linear' },
    ],
  },
  {
    id: 'early-drop',
    label: 'Early Drop',
    buildNormalized: () => [
      { x: 0, y: 1, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'linear' },
      { x: 0.72, y: 1, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.1, dy: -0.35 }, mode: 'linear' },
      { x: 1, y: 0, inTangent: { dx: -0.1, dy: 0.35 }, outTangent: { dx: 0.1, dy: 0 }, mode: 'linear' },
    ],
  },
  {
    id: 'spike',
    label: 'Spike',
    buildNormalized: () => [
      { x: 0, y: 0, inTangent: { dx: -0.2, dy: 0 }, outTangent: { dx: 0.2, dy: 0 }, mode: 'linear' },
      { x: 0.78, y: 0, inTangent: { dx: -0.1, dy: 0 }, outTangent: { dx: 0.04, dy: 0.28 }, mode: 'linear' },
      { x: 0.9, y: 0.85, inTangent: { dx: -0.04, dy: -0.28 }, outTangent: { dx: 0.04, dy: 0 }, mode: 'linear' },
      { x: 0.96, y: 0.85, inTangent: { dx: -0.03, dy: 0 }, outTangent: { dx: 0.02, dy: -0.4 }, mode: 'linear' },
      { x: 1, y: 0, inTangent: { dx: -0.02, dy: 0.4 }, outTangent: { dx: 0.02, dy: 0 }, mode: 'linear' },
    ],
  },
];

function mapPointsToDomain(
  pts: CurvePoint[],
  xRange: [number, number],
  yRange: [number, number],
): CurvePoint[] {
  const xSpan = xRange[1] - xRange[0];
  const ySpan = yRange[1] - yRange[0];
  return pts.map((p) => ({
    x: xRange[0] + p.x * xSpan,
    y: yRange[0] + p.y * ySpan,
    inTangent: {
      dx: p.inTangent.dx * xSpan,
      dy: p.inTangent.dy * ySpan,
    },
    outTangent: {
      dx: p.outTangent.dx * xSpan,
      dy: p.outTangent.dy * ySpan,
    },
    mode: p.mode,
    ...(p.weight !== undefined ? { weight: p.weight } : {}),
  }));
}

/**
 * Create a new Curve from a preset id, scaled to `xRange` and `yRange`.
 */
export function getCurvePreset(
  id: CurvePresetId,
  xRange: [number, number] = [0, 1],
  yRange: [number, number] = [0, 1],
): Curve {
  const def = CURVE_PRESETS.find((p) => p.id === id) ?? (CURVE_PRESETS[0] as CurvePresetDef);
  return {
    points: mapPointsToDomain(def.buildNormalized(), xRange, yRange),
    xRange: [xRange[0], xRange[1]],
    yRange: [yRange[0], yRange[1]],
    wrap: 'clamp',
    fixedEndpoints: true,
    valueMode: 'relative',
  };
}

/**
 * Apply a preset to an existing curve while preserving its domain, wrap, valueMode, and level.
 */
export function applyCurvePreset(curve: Curve, id: CurvePresetId): Curve {
  const def = CURVE_PRESETS.find((p) => p.id === id) ?? (CURVE_PRESETS[0] as CurvePresetDef);
  const points = mapPointsToDomain(def.buildNormalized(), curve.xRange, curve.yRange);
  return {
    ...curve,
    points,
    ...(curve.level !== undefined && curve.levelCurves
      ? { levelCurves: { ...curve.levelCurves, [curve.level]: points } }
      : {}),
  };
}

/**
 * Detect if `curve` matches one of the built-in presets (within small epsilon).
 */
export function detectCurvePreset(curve: Curve): CurvePresetId | null {
  const [x0, x1] = curve.xRange;
  const [y0, y1] = curve.yRange;
  const xSpan = x1 - x0 || 1;
  const ySpan = y1 - y0 || 1;

  for (const preset of CURVE_PRESETS) {
    const normPts = preset.buildNormalized();
    if (normPts.length !== curve.points.length) continue;
    let match = true;
    for (let i = 0; i < normPts.length; i++) {
      const a = normPts[i] as CurvePoint;
      const b = curve.points[i] as CurvePoint;
      const bx = (b.x - x0) / xSpan;
      const by = (b.y - y0) / ySpan;
      if (Math.abs(a.x - bx) > 1e-2 || Math.abs(a.y - by) > 1e-2 || a.mode !== b.mode) {
        match = false;
        break;
      }
    }
    if (match) return preset.id;
  }
  return null;
}
