/** Branch UV mapping (R16): configuration types shared by the pure math, the node parameter reader and the tube mesher. */

/** UV Mapping > Style: how far the coordinates may leave the 0..1 square. */
export type UvStyle = 'unrestricted' | 'u-locked' | 'uv-locked';
/** UV Mapping > Extension style: how an extension continues the mapping of the branch it extends. */
export type ExtensionUvStyle = 'automatic' | 'match' | 'match-u' | 'full';
/** V > Style. */
export type VStyle = 'absolute' | 'aspect' | 'relative';
/** V > Anchor: the end of the branch whose V sits on a whole number. */
export type VAnchor = 'start' | 'end';
/** Tiling > Style. */
export type TilingStyle = 'tiling' | 'patch-one' | 'patch-all';

/** `[u0, v0, u1, v1]` inside the 0..1 UV square. */
export type UvRect = readonly [number, number, number, number];

export interface FractionalU {
  enabled: boolean;
  /** Match the texel density of the parent (tiles per metre of circumference). */
  auto: boolean;
  /** Free tile count around the branch (used when Enable is on and Auto is off). */
  value: number;
}

export interface UvMapping {
  style: UvStyle;
  extensionStyle: ExtensionUvStyle;
  /** Swap U and V (rotate the texture by 90 degrees). */
  rotate: boolean;
  uAbsolute: number;
  /** Tiles per metre of circumference (times the legacy `uvScaleU` of old projects). */
  uRelative: number;
  uOffset: number;
  uOffsetVariance: number;
  fractional: FractionalU;
  /** Revolutions around the branch per V tile. */
  twist: number;
  twistRandomFlip: boolean;
  vStyle: VStyle;
  vAnchor: VAnchor;
  vScale: number;
  /** 0..1: how much a changing radius is compensated by the aspect-ratio style. */
  skew: number;
  /** 0..1: lifts the radius used near the tip so V does not race away. */
  pinch: number;
  vOffset: number;
  vOffsetVariance: number;
  tiling: TilingStyle;
  optimizeSegments: boolean;
  /** V distance from a whole number inside which a ring is moved onto it. */
  vTolerance: number;
  tilingSeed: number;
  /** Cut real geometry (doubled ring vertices) at every whole U tile border so each tile is its own UV island (UV seams). */
  createSeams: boolean;
}

export const DEFAULT_UV_MAPPING: UvMapping = {
  style: 'unrestricted',
  extensionStyle: 'automatic',
  rotate: false,
  uAbsolute: 0,
  uRelative: 1,
  uOffset: 0,
  uOffsetVariance: 0,
  fractional: { enabled: false, auto: false, value: 1 },
  twist: 0,
  twistRandomFlip: false,
  vStyle: 'absolute',
  vAnchor: 'start',
  vScale: 1,
  skew: 0,
  pinch: 0.25,
  vOffset: 0,
  vOffsetVariance: 0,
  tiling: 'tiling',
  optimizeSegments: false,
  vTolerance: 0.1,
  tilingSeed: 0,
  createSeams: false,
};

/** Skeleton attributes written by the tube mesher so children / extensions can continue the parent's mapping. */
export const UV_TILES_ATTR = 'uvTiles';
export const UV_DENSITY_ATTR = 'uvDensity';
export const UV_V_ATTR = 'uvV';
export const UV_TWIST_ATTR = 'uvTwist';
export const UV_UOFFSET_ATTR = 'uvUOffset';

/** Row value of an `Inherited` material (follows the parent generator's material). */
export const MATERIAL_INHERITED = 'inherited';
