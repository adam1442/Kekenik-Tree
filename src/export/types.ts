/** Shared shapes of the export pipeline. Everything in `src/export/` except the *.browser files is DOM-free. */

export type ExportFormat = 'glb' | 'gltf' | 'obj' | 'ply' | 'stl';
export type UpAxis = 'Y' | 'Z';
export type Handedness = 'right' | 'left';
export type ImageFormat = 'png' | 'jpg' | 'webp';
export type ExportUnits = 'm' | 'cm' | 'mm' | 'in' | 'ft';
export type MergeMode = 'single' | 'perNode';
export type LodLayout = 'files' | 'single';
export type ImpostorMode = 'off' | 'impostor' | 'cross' | 'both';
export type AoVertexMode = 'off' | 'multiply' | 'replace';
export type ChannelPacking = 'none' | 'orm';

/** Metres per unit (the scene is authored in metres). */
export const UNIT_SCALE: Record<ExportUnits, number> = { m: 1, cm: 100, mm: 1000, in: 39.37007874, ft: 3.280839895 };

export interface LodLevelSettings {
  /** Generator detail 0..3: radial sides, segment counts and the per-node LOD curves of the graph (see `ctx.lod`). */
  engineLod: number;
  /** Fraction (0.02..1) of leaf / frond / mesh pieces kept after generation. */
  foliageKeep: number;
  /** Enlarge the remaining foliage pieces so the covered area (silhouette) stays the same. */
  keepSilhouette: boolean;
  /** Bark pieces whose bounding diagonal is below this percentage of the plant height are removed (0 = keep all). */
  minBranchSize: number;
  /** Screen height fraction (0..1) at or below which the engine switches to this LOD. LOD0 is always 1. */
  transition: number;
  /** Triangle budget (0 = unlimited): the foliage is thinned further to fit when the level exceeds it. */
  triangleBudget: number;
}

export interface LodSettings {
  levels: LodLevelSettings[];
}

export interface TextureExportSettings {
  enabled: boolean;
  format: ImageFormat;
  /** JPG / WebP quality 0.1..1. */
  quality: number;
  /** Maximum edge in px (0 = use each material's Max res). Never upsamples. */
  maxSize: number;
  packing: ChannelPacking;
  /** Dilation (px) of colour under transparent texels so mips do not bleed. */
  padding: number;
  /** Write the maps next to the model (glTF uses uris, the zip gets a textures/ folder) instead of embedding. */
  external: boolean;
}

export interface BakeSettings {
  aoMode: AoVertexMode;
  /** Rays per vertex. */
  aoSamples: number;
  /** Occlusion distance as a fraction of the plant height. */
  aoRadius: number;
  aoStrength: number;
}

export interface ImpostorSettings {
  mode: ImpostorMode;
  /** Horizontal views (4..32). */
  views: number;
  topView: boolean;
  /** Edge of one frame in px. */
  frameSize: number;
  /** Dilation in px. */
  padding: number;
  normals: boolean;
  depth: boolean;
  /** LOD whose geometry is rendered. */
  sourceLod: number;
}

export interface ExportSettings {
  name: string;
  format: ExportFormat;
  /** Selected LOD indices. */
  lods: number[];
  lodLayout: LodLayout;
  mergeMode: MergeMode;
  units: ExportUnits;
  upAxis: UpAxis;
  handedness: Handedness;
  /** Extra uniform scale on top of the unit conversion. */
  scale: number;
  zip: boolean;
  /** Write the Kekenik custom attributes (`_WIND_PIVOT`, `_WIND_WEIGHTS`, `_AO`). */
  customAttributes: boolean;
  vertexColors: boolean;
  /** Write `<name>.kekenik.json` (stats, LODs, wind, materials). */
  metadata: boolean;
  /** Re-import the exported GLB / glTF and compare the statistics. */
  verify: boolean;
  textures: TextureExportSettings;
  bake: BakeSettings;
  impostor: ImpostorSettings;
}

export interface ExportFile {
  name: string;
  data: Uint8Array | string;
  mime: string;
}

export interface GeometryStats {
  triangles: number;
  vertices: number;
  drawCalls: number;
}

export interface ExportProgress {
  stage: string;
  /** 0..1 over the whole export. */
  fraction: number;
}
