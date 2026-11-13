import { clamp } from '@/core/math';

/**
 * Curve & Ramp data structures and point/curve builders.
 * Pure, DOM-free bottom-layer module in `src/core/curve/`.
 */

export type TangentMode =
  | 'auto'
  | 'smooth'
  | 'linear'
  | 'flat'
  | 'free'
  | 'stepped'
  | 'constant'
  | 'aligned'
  | 'mirrored';

export type WrapMode = 'clamp' | 'loop' | 'repeat' | 'pingpong';

export type CurveValueMode = 'relative' | 'absolute';

export interface TangentVector {
  dx: number;
  dy: number;
}

export interface CurvePoint {
  x: number;
  y: number;
  /** Incoming tangent vector offset (dx <= 0 typically, dy = slope * dx). */
  inTangent: TangentVector;
  /** Outgoing tangent vector offset (dx >= 0 typically, dy = slope * dx). */
  outTangent: TangentVector;
  mode: TangentMode;
  /** Optional tangent weight in [0, 1] when weighted Hermite/Bezier handles are used. */
  weight?: number;
}

export interface Curve {
  /** Points MUST be sorted by ascending x. */
  points: CurvePoint[];
  xRange: [number, number];
  yRange: [number, number];
  wrap: WrapMode;
  /** Whether the first and last points are locked to xRange[0] and xRange[1]. */
  fixedEndpoints?: boolean;
  /** Toolbar evaluation/display mode ("Relative" vs "Absolute"). */
  valueMode?: CurveValueMode;
  /** Active parent-level index (1-based, e.g. 1 = immediate parent, 2..5 = ancestor levels shown as badge). */
  level?: number;
  /** Optional multi-level curves indexed by parent level (1..N). */
  levelCurves?: Record<number, CurvePoint[]>;
}

export interface RampStop {
  /** Position in [0, 1]. */
  t: number;
  /** RGBA in [0, 1]. */
  color: [number, number, number, number];
}

export type RampInterpolation = 'linear' | 'step' | 'smooth';

export interface Ramp {
  stops: RampStop[];
  interpolation: RampInterpolation;
}

/** Signature other modules rely on for curve evaluation. */
export type EvaluateCurveFn = (curve: Curve, x: number) => number;

export function linearPoint(x: number, y: number): CurvePoint {
  return {
    x,
    y,
    inTangent: { dx: -0.1, dy: 0 },
    outTangent: { dx: 0.1, dy: 0 },
    mode: 'linear',
  };
}

export function steppedPoint(x: number, y: number): CurvePoint {
  return {
    x,
    y,
    inTangent: { dx: 0, dy: 0 },
    outTangent: { dx: 0, dy: 0 },
    mode: 'stepped',
  };
}

/** Constant curve helper (the default curve is a flat line at y = 1). */
export function flatCurve(value = 1, xRange: [number, number] = [0, 1], yRange: [number, number] = [0, 1]): Curve {
  const span = Math.max(1e-4, xRange[1] - xRange[0]);
  const third = span / 3;
  return {
    points: [
      { x: xRange[0], y: value, inTangent: { dx: -third, dy: 0 }, outTangent: { dx: third, dy: 0 }, mode: 'linear' },
      { x: xRange[1], y: value, inTangent: { dx: -third, dy: 0 }, outTangent: { dx: third, dy: 0 }, mode: 'linear' },
    ],
    xRange: [xRange[0], xRange[1]],
    yRange: [yRange[0], Math.max(yRange[1], value)],
    wrap: 'clamp',
  };
}

/** Linear ascending curve from (x0, y0) to (x1, y1). */
export function linearCurve(
  y0 = 0,
  y1 = 1,
  xRange: [number, number] = [0, 1],
  yRange: [number, number] = [0, 1],
): Curve {
  const span = Math.max(1e-4, xRange[1] - xRange[0]);
  const dy = y1 - y0;
  const third = span / 3;
  return {
    points: [
      {
        x: xRange[0],
        y: y0,
        inTangent: { dx: -third, dy: -dy / 3 },
        outTangent: { dx: third, dy: dy / 3 },
        mode: 'linear',
      },
      {
        x: xRange[1],
        y: y1,
        inTangent: { dx: -third, dy: -dy / 3 },
        outTangent: { dx: third, dy: dy / 3 },
        mode: 'linear',
      },
    ],
    xRange: [xRange[0], xRange[1]],
    yRange: [Math.min(yRange[0], y0, y1), Math.max(yRange[1], y0, y1)],
    wrap: 'clamp',
  };
}

export function cloneCurvePoint(p: CurvePoint): CurvePoint {
  return {
    x: p.x,
    y: p.y,
    inTangent: { dx: p.inTangent.dx, dy: p.inTangent.dy },
    outTangent: { dx: p.outTangent.dx, dy: p.outTangent.dy },
    mode: p.mode,
    ...(p.weight !== undefined ? { weight: p.weight } : {}),
  };
}

export function cloneCurve(curve: Curve): Curve {
  const out: Curve = {
    points: curve.points.map(cloneCurvePoint),
    xRange: [curve.xRange[0], curve.xRange[1]],
    yRange: [curve.yRange[0], curve.yRange[1]],
    wrap: curve.wrap,
  };
  if (curve.fixedEndpoints !== undefined) out.fixedEndpoints = curve.fixedEndpoints;
  if (curve.valueMode !== undefined) out.valueMode = curve.valueMode;
  if (curve.level !== undefined) out.level = curve.level;
  if (curve.levelCurves) {
    out.levelCurves = {};
    for (const [k, pts] of Object.entries(curve.levelCurves)) {
      out.levelCurves[Number(k)] = pts.map(cloneCurvePoint);
    }
  }
  return out;
}

export function cloneRamp(ramp: Ramp): Ramp {
  return {
    interpolation: ramp.interpolation,
    stops: ramp.stops.map((s) => ({
      t: clamp(s.t, 0, 1),
      color: [s.color[0], s.color[1], s.color[2], s.color[3]],
    })),
  };
}

export function defaultRamp(): Ramp {
  return {
    interpolation: 'linear',
    stops: [
      { t: 0, color: [0.22, 0.36, 0.12, 1] },
      { t: 1, color: [0.58, 0.78, 0.32, 1] },
    ],
  };
}
