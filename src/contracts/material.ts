import type { Curve } from './curve';
import type { ParamState, RGBA } from './params';

/** Materials, forces, wind (data shapes). */

export type TextureSlot =
  | 'color'
  | 'opacity'
  | 'normal'
  | 'gloss'
  | 'specular'
  | 'metallic'
  | 'subsurface'
  | 'subsurfacePercent'
  | 'ao'
  | 'height'
  | 'custom'
  | 'custom2';

/** Reference to an image asset in ProjectFile.assets. */
export interface TextureRef {
  assetId: string;
}

/** A slot is driven by a scalar/colour constant, a texture, or both (texture × constant). */
export interface MaterialSlotValue {
  color?: RGBA;
  scalar?: number;
  texture?: TextureRef | null;
}

export interface MaterialDef {
  id: string;
  name: string;
  twoSided: boolean;
  /** Season response curve. */
  season?: Curve | null;
  /** Three tint variations + blend amount. */
  variations: [RGBA, RGBA, RGBA];
  variationAmount: number;
  slots: Partial<Record<TextureSlot, MaterialSlotValue>>;
  atlas: { scale: number; handling: 'default' | 'cutout' | 'mesh'; name: string };
  maxResolution: number | null;
  backMaterialId: string | null;
  backSpacing: number;
  userData: string;
}

/** Weighted, season-aware member of a MaterialSet. */
export interface MaterialSetMember {
  id: string;
  materialId: string;
  weight: number;
  /** Per-member season response; null = use the material's own season curve. */
  season?: Curve | null;
}

/** Named collection of materials (e.g. Summer / Autumn / Winter). Generators may reference a set id instead of a material id. */
export interface MaterialSetDef {
  id: string;
  name: string;
  overrideSeason: boolean;
  /** Season curve used for every member when `overrideSeason` is on. */
  season?: Curve | null;
  members: MaterialSetMember[];
}

export type MaskType = 'terrain';
export type MaskBehavior = 'inclusive' | 'exclusive';

/** Terrain mask: selects where something may grow by slope and elevation. */
export interface MaskDef {
  id: string;
  name: string;
  behavior: MaskBehavior;
  /** Width of the soft falloff outside the [min, max] ranges (in normalised range units). */
  fuzziness: number;
  type: MaskType;
  slope: { min: number; max: number };
  elevationMode: 'relative' | 'absolute';
  relativeElevation: { min: number; max: number };
  absoluteElevation: { min: number; max: number };
}

export type DisplacementChannel = 'greyscale' | 'r' | 'g' | 'b' | 'a' | 'luminance';

/** Height image processed into a displacement field (see materials/displacement.ts). */
export interface DisplacementDef {
  id: string;
  name: string;
  /** Asset id of the source image (ProjectFile.assets), '' when none. */
  assetId: string;
  fileName: string;
  channel: DisplacementChannel;
  smoothing: number;
  brightness: number;
  contrast: number;
  normalize: boolean;
}

export type LodLevel = 'high' | 'med' | 'low';

export type TessellationMode = 'Triangular' | 'Quad' | 'Convex Hull' | 'None';

export type MeshOrientMode =
  | 'Z-Up Right-handed'
  | 'Y-Up Right-handed'
  | 'Z-Up Left-handed'
  | 'Y-Up Left-handed';

export type MeshFlipMode = 'None' | 'X' | 'Y' | 'Z' | 'X Y' | 'X Z' | 'Y Z' | 'X Y Z';

export type WindGrowthAxis = '+Y' | '-Y' | '+X' | '-X' | '+Z' | '-Z';

export type WindRippleMode = 'Normal' | 'Tangent' | 'Binormal' | 'Up' | 'Radial';

/** Anchor marker placed on a cutout/mesh (green pivot dot + white direction handle in Edit Mesh). */
export interface CutoutAnchor {
  id: string;
  /** Position in UV space (u in 0..1 left-to-right, v in 0..1 bottom-to-top). */
  uv: [number, number];
  /** Handle position in UV space indicating local branch/leaf direction. */
  handleUv: [number, number];
  /** Optional 3D anchor position for imported 3D meshes. */
  position3d?: [number, number, number];
  /**
   * Attachment-frame data. The anchor DIRECTION is `handleUv - uv` (the white handle); its position along
   * the Straighten axis (`axisT`) is derived at runtime (see `materials/cutouts/frame.ts`). All fields optional.
   */
  name?: string;
  /** Rotation (degrees) of the facing around the anchor direction. Default 0. */
  roll?: number;
  /** Size multiplier handed to the child planted on this anchor. Default 1. */
  scale?: number;
  tags?: string[];
}

/** Straighten axis mode (Edit Mesh > Straighten). */
export type StraightenMode = 'linear' | 'curve';

/** Serialisable 3D mesh data for an imported LOD override (OBJ/GLB loaded in the Meshes panel). */
export interface ImportedLodMesh {
  assetId?: string;
  fileName: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/** Per-LOD variant (High / Med / Low) of a CutoutMesh. */
export interface CutoutLodVariant {
  level: LodLevel;
  /** Simplification step offset (adjusted via <- / -> arrows in Edit Mesh). */
  step: number;
  /** Flattened UV vertex coordinates [u0, v0, u1, v1, ...]. */
  vertices: number[];
  /** Triangle indices into `vertices` (3 per face). */
  indices: number[];
  /** Source label shown in the Meshes panel ("Embedded" or imported file name). */
  sourceName: string;
  /** Optional imported 3D mesh override for this LOD slot. */
  importedMesh?: ImportedLodMesh | null;
}

/** Per-vertex and brush-grid paint data authored in the Edit Mesh Paint tools. */
export interface CutoutPaintLayers {
  /** Per-vertex mask weight (0..1, 1 = marked/active). */
  vertexMask: number[];
  /** Per-vertex RGBA color [r, g, b, a, ...] (4 floats per vertex, default 1,1,1,1). */
  vertexColor: number[];
  /** Per-vertex section id (1..8, default 1). */
  vertexSection: number[];
  /** Optional 2D raster grid size (e.g. 32) for continuous brush strokes in UV space. */
  gridSize?: number;
  maskGrid?: number[];
  colorGrid?: number[];
  sectionGrid?: number[];
}

export interface CutoutTessellationSettings {
  angle: number;
  tessellation: TessellationMode;
  tessAmount: number;
  refineEdges: number;
  snapThreshold: number;
  doubleSided: boolean;
  opacityMargin: number;
  opacityMarginEnabled: boolean;
}

export interface MeshTransformSettings {
  orient: MeshOrientMode;
  flip: MeshFlipMode;
  flipNormals: boolean;
  fixWinding: boolean;
}

export interface MeshWindDirectionSettings {
  growth: WindGrowthAxis;
  ripple: WindRippleMode;
}

/**
 * Cutout / Mesh asset. Represents both 2D polygon cutouts authored in "Edit Mesh"
 * and 3D meshes managed in the "Meshes" panel.
 */
export interface CutoutMesh {
  id: string;
  name: string;
  materialId: string;
  /** Boundary polygon points in UV space (u in 0..1, v in 0..1 where v=0 is bottom/base, v=1 is top/tip). */
  outline: [number, number][];
  /** Interior Steiner vertices in UV space (u, v). */
  interiorPoints: [number, number][];
  /** Base triangulation indices into `[...outline, ...interiorPoints]`. */
  indices: number[];
  /** Precomputed High / Med / Low LOD variants. */
  lods: Record<LodLevel, CutoutLodVariant>;
  /** Straighten axis polyline in UV space from base to tip (orange curve in Edit Mesh). */
  straightenAxis: [number, number][];
  /** True when `Linear` mode is active: the axis is the straight line between its first and last point. */
  straightenLinear: boolean;
  /** Anchor points (green/white joint markers). */
  anchors: CutoutAnchor[];
  /** Paint layers (Mask, Color, Section [n]). */
  paint: CutoutPaintLayers;
  /** Pivot point in UV space (default [0.5, 0] at bottom-center stem base). */
  pivot: [number, number];
  /** Double-sided flag. */
  doubleSided: boolean;
  /** Edit Mesh tessellation & contour generation parameters. */
  settings: CutoutTessellationSettings;
  /** Real-world bounding size in metres [width, height]. */
  boundsMeters: [number, number];
  /** Scale multiplier from the Meshes panel (default 1). */
  scale: number;
  /** Transform settings from the Meshes panel. */
  transform: MeshTransformSettings;
  /** Wind direction settings from the Meshes panel. */
  windDirection: MeshWindDirectionSettings;
  /** Optional UV Area id when scoped to a sub-region of an atlas. */
  uvAreaId?: string | null;
  /** Version of the axis / anchor data. Absent = authored before attachment frames existed. */
  attachVersion?: number;
}

/** Named rectangular or polygonal UV region on a material atlas. */
export interface UVAreaDef {
  id: string;
  name: string;
  materialId: string;
  shape: 'rect' | 'polygon';
  /** [u0, v0, u1, v1] in 0..1 UV space. */
  rect: [number, number, number, number];
  /** Polygon vertices in 0..1 UV space when shape === 'polygon'. */
  polygon?: [number, number][];
  /** Pivot in UV space. */
  pivot: [number, number];
  /** Target generator usage tag. */
  usage: 'any' | 'leaf' | 'bark' | 'cap' | 'frond';
  /** Relative selection weight. */
  weight: number;
}

export type ForceKind = 'directional' | 'point' | 'vortex' | 'gravity' | 'phototropism' | 'custom';

export interface ForceDef {
  id: string;
  name: string;
  /** Free-form string so new force types can be registered. */
  type: ForceKind | string;
  enabled: boolean;
  params: Record<string, ParamState>;
}

export interface WindSettings {
  enabled: boolean;
  /** Direction in degrees around Z. */
  directionDeg: number;
  strength: number;
  gustiness: number;
  frequency: number;
  /** Extra per-type tuning, free-form. */
  params: Record<string, ParamState>;
}

export function defaultWindSettings(): WindSettings {
  return { enabled: false, directionDeg: 0, strength: 1, gustiness: 0.3, frequency: 1, params: {} };
}
