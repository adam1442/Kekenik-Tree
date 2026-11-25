/**
 * Data-driven texture packing. A packer is a plain JSON-like object: a list of output textures, each naming for its R / G / B / A
 * channel which source map and channel to read. No code is needed to add an engine preset.
 */
export type PackSource = 'color' | 'opacity' | 'normal' | 'height' | 'ao' | 'gloss' | 'roughness' | 'metallic';
export type PackChannel = 'r' | 'g' | 'b' | 'a';

export interface ChannelSpec {
  /** Source map; absent = the channel is the constant `value`. */
  source?: PackSource;
  /** Channel of the source image (default `r`). */
  channel?: PackChannel;
  /** 1 - value (e.g. gloss -> roughness, DirectX normals). */
  invert?: boolean;
  /** Constant used when the source map is missing (and for channels without a source), 0..1. */
  value: number;
}

export interface MipFlags {
  /** The alpha channel is an opacity: the mip chain keeps the alpha-test coverage (`src/textures/alphaCoverage`). */
  alphaIsOpacity: boolean;
  /** RGB is a tangent-space normal: mips average the decoded vectors and renormalise (`src/textures/normalMips`). */
  rgbIsNormal: boolean;
}

export interface PackedTextureDef {
  /** Stable id, also the file suffix (`<material>_<suffix>.png`). */
  suffix: string;
  /** What the texture is called in the target engine. */
  label: string;
  r: ChannelSpec;
  g: ChannelSpec;
  b: ChannelSpec;
  a: ChannelSpec;
  /** True for colour data (sRGB), false for data textures. */
  srgb: boolean;
  mip: MipFlags;
}

export interface PackerDef {
  id: string;
  label: string;
  description: string;
  textures: PackedTextureDef[];
}

/** Source images (straight-alpha RGBA8, equal or different sizes: the packer resizes) and the constants of the material slots. */
export interface PackInputs {
  images: Partial<Record<PackSource, import('../images/imageOps').RGBAImage>>;
  /** Slot constants 0..1 used when a map is missing (and multiplied into a present one for gloss / roughness / metallic / ao). */
  scalars: Partial<Record<PackSource, number>>;
}

export interface PackOptions {
  /** Write a tiny (4 x 4) texture even when every channel is a constant. false = the constant is reported instead. */
  forceTextures: boolean;
  /** Alpha cut-off (0..1) the opacity mips preserve. */
  alphaCutoff: number;
  /** Edge cap in px (0 = none). */
  maxSize: number;
}

export interface PackedTexture {
  suffix: string;
  label: string;
  srgb: boolean;
  image: import('../images/imageOps').RGBAImage;
  /** Mip chain (level 0 = `image` possibly alpha-corrected) built with the def's mip flags. */
  mips: import('../images/imageOps').RGBAImage[];
  /** True when the texture only exists because of `forceTextures` (all channels constant). */
  forced: boolean;
}

export interface PackResult {
  packer: string;
  textures: PackedTexture[];
  /** Textures that were skipped because every channel is constant: suffix -> [r, g, b, a] (0..1) to store in the material instead. */
  constants: Record<string, [number, number, number, number]>;
}
