import type { Rng } from '@/core/rng';

export type V3 = [number, number, number];

/**
 * How a force acts on a branch:
 *  - `load`  : a distributed load (weight, wind push, turbulence). Integrated as a cantilever beam: the bending
 *              moment at every joint is divided by the bending stiffness EI ~ r^4, so thin / long parts bend more.
 *  - `steer` : a growth tendency (phototropism, attractors, vortex ...). Turns every segment towards the field.
 * Both modes only ever ROTATE rigid segments, so branch length is preserved exactly.
 */
export type ForceMode = 'load' | 'steer';

/** Point of a branch a field is sampled at (reused object, do not keep a reference). */
export interface FieldPoint {
  x: number;
  y: number;
  z: number;
  /** Current unit direction of the segment. */
  dx: number;
  dy: number;
  dz: number;
  /** Normalised arc length along the branch, 0..1. */
  t: number;
  radius: number;
  /** Generation relative to the lowest generation of the skeleton. */
  generation: number;
}

/** Writes the (unscaled, roughly unit-magnitude) force vector at a point into `out`. */
export type FieldFn = (p: FieldPoint, out: V3) => void;

export interface ForceTypeDef {
  /** Value of `ForceDef.type`. */
  type: string;
  mode: ForceMode;
  /** Load only: the load scales with (radius / refRadius)^loadExponent (2 = weight, 1 = projected area). */
  loadExponent: number;
  /** Build the field function once per `applyForces` call. */
  compile(params: import('@/contracts/params').NodeParams): FieldFn;
}

export interface ForceContext {
  rng: Rng;
  /** Generator-level influence multiplier along the branch length (Forces tab of the generator). */
  influence?: (t: number) => number;
  /** Generator-level stiffness multiplier along the branch length. */
  stiffness?: (t: number) => number;
  /** Max rotation of a single segment in radians (default 0.5). */
  maxSegmentAngle?: number;
  /** Max total deflection of a segment from its undeformed direction in radians (default 110 deg). */
  maxTotalAngle?: number;
  /** Relaxation passes for the load solver (default 2). */
  iterations?: number;
}

export interface ForceStats {
  appliedForces: number;
  branches: number;
  maxDisplacement: number;
}
