/** Stored values of the `Relative basis` enums (`optionValue` of the labels in the inspector). */
export const LENGTH_BASIS = { length: 'length-only', ratio: 'length-radius-ratio', parent: 'parent-s-length-segments' } as const;
export const RADIAL_BASIS = { radius: 'radius', parent: 'parent-s-radial-segments' } as const;

export type LengthSegmentStyle = 'default' | 'legacy';

/** Number of points of the high-resolution spine: exactly `accuracy`, never fewer than 3. */
export function accuratePointCount(accuracy: number): number {
  return Math.max(3, Math.min(1024, Math.round(accuracy)));
}

/** Integration steps of the high-resolution spine (points - 1). */
export function accurateStepCount(accuracy: number): number {
  return accuratePointCount(accuracy) - 1;
}

/**
 * Gain of one accurate segment for forces and spine properties. Dividing by the step count keeps the total effect of a
 * property independent of Accuracy; Influence scales it (2 = twice as strong, 0 = disabled).
 */
export function influenceGain(influence: number, steps: number): number {
  return Math.max(0, influence) / Math.max(1, steps);
}

export interface LengthSegmentInput {
  style: LengthSegmentStyle;
  absolute: number;
  relative: number;
  basis: string;
  /** Arc length of the spine part that is generated, metres. */
  length: number;
  /** Radius at the base of the branch, metres. */
  radius: number;
  /** Length segments of the parent branch (0 when there is none). */
  parentSegments: number;
  /** Scalar of the Segments tab (polygon count multiplier). */
  scalar: number;
}

/**
 * Final length segments of a branch. Default style: `Absolute + Relative x basis` where the basis is the branch length,
 * the length / radius ratio or the parent's segment count. Legacy: `Absolute + Relative x length` (per metre).
 */
export function lengthSegmentCount(i: LengthSegmentInput): number {
  const abs = Math.max(0, i.absolute);
  const rel = Math.max(0, i.relative);
  let basisValue = i.length;
  if (i.style === 'default') {
    if (i.basis === LENGTH_BASIS.ratio) basisValue = i.length / Math.max(1e-4, i.radius);
    else if (i.basis === LENGTH_BASIS.parent) basisValue = Math.max(0, i.parentSegments);
  }
  return Math.max(1, Math.round((abs + rel * basisValue) * Math.max(0, i.scalar)));
}

export interface RadialSegmentInput {
  absolute: number;
  relative: number;
  basis: string;
  /** Radius at the base of the branch, metres. */
  radius: number;
  /** Radial segments of the parent branch (0 when there is none). */
  parentSides: number;
  scalar: number;
}

/** Final radial segments: `Absolute + Relative x basis` (the radius in metres or the parent's radial segments), at least 3. */
export function radialSegmentCount(i: RadialSegmentInput): number {
  const basisValue = i.basis === RADIAL_BASIS.parent ? Math.max(0, i.parentSides) : Math.max(0, i.radius);
  return Math.max(3, Math.round((Math.max(0, i.absolute) + Math.max(0, i.relative) * basisValue) * Math.max(0, i.scalar)));
}

/** Segments inside the weld part (where the branch is fused to its parent): the natural count scaled, at least 1. */
export function weldSegmentCount(natural: number, weldScalar: number): number {
  return Math.max(1, Math.round(Math.max(0, natural) * Math.max(0, weldScalar)));
}

/**
 * Re-spaces the samples inside the weld part (the first `weldLength` metres of the high-resolution spine) so that it holds
 * `natural x weldScalar` segments; samples beyond the weld part are kept. `indices` are ascending dense-spine indices.
 */
export function reshapeWeldSamples(
  positions: ArrayLike<number>,
  denseCount: number,
  indices: Int32Array,
  weldLength: number,
  weldScalar: number,
): Int32Array {
  let weldEnd = 0;
  let arc = 0;
  for (let k = 1; k < denseCount; k++) {
    arc += Math.hypot(
      (positions[k * 3] as number) - (positions[(k - 1) * 3] as number),
      (positions[k * 3 + 1] as number) - (positions[(k - 1) * 3 + 1] as number),
      (positions[k * 3 + 2] as number) - (positions[(k - 1) * 3 + 2] as number),
    );
    if (arc > weldLength) break;
    weldEnd = k;
  }
  if (weldEnd < 1) return indices;
  let natural = 0;
  for (const i of indices) if (i > 0 && i <= weldEnd) natural++;
  const w = Math.min(weldEnd, weldSegmentCount(Math.max(1, natural), weldScalar));
  const out: number[] = [];
  for (let q = 0; q <= w; q++) {
    const idx = Math.round((q * weldEnd) / w);
    if (out.length === 0 || idx > (out[out.length - 1] as number)) out.push(idx);
  }
  for (const i of indices) if (i > weldEnd) out.push(i);
  if ((out[out.length - 1] as number) !== denseCount - 1 && indices.length > 0) out.push(denseCount - 1);
  return Int32Array.from(out);
}
