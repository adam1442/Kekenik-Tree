/**
 * Knot generator (R17): configuration types shared by the pure geometry, the node parameter reader and the tests.
 *
 * A knot is three concentric sections welded onto the surface of its parent branch:
 * Outer (outermost band, always the parent material, UV equals the parent's), Inner (thin bridge) and Core (centre cap).
 * All sizes are metres; `*Frac` values are 0..1 fractions.
 */
import type { UvRect } from '@/generators/uv';

export type V3 = readonly [number, number, number];

/** Inner / Core > UV > Style. */
export type KnotUvStyle = 'match-trunk' | 'ring';

export interface KnotNoise {
  /** Strength (shape: fraction of the radius; offset: metres). */
  amount: number;
  /** Frequency over the knot (noise periods across the knot size). */
  scale: number;
}

export interface KnotUv {
  style: KnotUvStyle;
  scale: number;
  offsetU: number;
  offsetV: number;
  /** UV Area of the chosen material row (null = whole map: the coordinates tile freely). */
  rect: UvRect | null;
}

/** Everything that describes one knot (values already sampled with their variance). */
export interface KnotShape {
  /** Outer radius along the branch (m). */
  size: number;
  /** Extrusion of the rim from the parent surface (m; negative cuts into it). */
  offset: number;
  /** Roll of the whole knot around its centre (radians). */
  rotation: number;
  /** Width across the branch relative to the length along it. */
  width: number;
  /** Extra height of the edge between Outer and Inner (m). */
  lip: number;
  outerShape: KnotNoise;
  outerOffset: KnotNoise;
  inner: {
    /** Size of Inner + Core as a fraction of the knot size. */
    sizeFrac: number;
    /** Width of Inner and Core relative to Outer. */
    scale: number;
    curvature: number;
    /** 0..1: how far Inner reaches under the Core. */
    overlap: number;
    uv: KnotUv;
    shape: KnotNoise;
  };
  core: {
    /** Size of the Core as a fraction of the Inner size. */
    sizeFrac: number;
    /** Height of the Core cap relative to the rim base (m; negative = towards the parent). */
    offset: number;
    uv: KnotUv;
    shape: KnotNoise;
    offsetNoise: KnotNoise;
  };
}

/** Ring and slice counts of one knot (rings = bands per section). */
export interface KnotSegments {
  outer: number;
  inner: number;
  core: number;
  slices: number;
}

/** Local surface frame of the parent branch at the centre of the knot. */
export interface KnotFrame {
  /** Point on the parent axis. */
  axisPoint: V3;
  tangent: V3;
  /** Ring frame (angle 0 direction) and `tangent x normal` (angle +90 degrees). */
  normal: V3;
  binormal: V3;
  /** Radius of the surface the knot is welded to (already scaled for the polygonal sag). */
  radius: number;
  /** d(radius) / d(metre along the tangent). */
  slope: number;
  /** Angle of the knot centre around the parent (radians, from `normal` towards `binormal`). */
  azimuth: number;
}

/** UV of the parent's tube at the knot (what Outer must match). */
export interface ParentUv {
  /** Texture tiles around the parent. */
  tiles: number;
  uOffset: number;
  /** Revolutions per V tile. */
  twist: number;
  /** V at the knot centre. */
  v0: number;
  /** V per metre along the parent axis. */
  vSlope: number;
}

export const SECTION_OUTER = 0;
export const SECTION_INNER = 1;
export const SECTION_CORE = 2;

export interface KnotMesh {
  vertexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array;
  uvs: Float32Array;
  /** Position in the knot plane normalised to 0..1 (lightmap UV). */
  plane: Float32Array;
  ao: Float32Array;
  /** `SECTION_*` of every vertex. */
  section: Uint8Array;
  /** Triangles sorted by section: Outer, Inner, Core. */
  indices: Uint32Array;
  /** `[start, count]` in `indices` per section. */
  ranges: readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
  /** Ring bands per section and slices actually built. */
  segments: KnotSegments;
  /** Boundary radii (m, in the knot plane before the roll) per slice: Outer edge, Outer / Inner edge, Inner / Core edge. */
  boundary: { outer: Float64Array; inner: Float64Array; core: Float64Array };
  /** Surface points of the Outer edge (height 0) = where the knot meets the parent. */
  rim: Float32Array;
}

export interface KnotNoiseSource {
  noise2(x: number, y: number): number;
}
