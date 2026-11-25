import type { ChannelSpec, PackedTextureDef, PackerDef } from './types';

const c = (value: number): ChannelSpec => ({ value });
const src = (source: ChannelSpec['source'], channel: ChannelSpec['channel'], value: number, invert = false): ChannelSpec => ({ ...(source ? { source } : {}), ...(channel ? { channel } : {}), ...(invert ? { invert } : {}), value });
const NO_MIP = { alphaIsOpacity: false, rgbIsNormal: false };

const colorOpacity = (suffix: string, label: string): PackedTextureDef => ({
  suffix,
  label,
  r: src('color', 'r', 1),
  g: src('color', 'g', 1),
  b: src('color', 'b', 1),
  a: src('opacity', 'r', 1),
  srgb: true,
  mip: { alphaIsOpacity: true, rgbIsNormal: false },
});

const normalHeight = (suffix: string, label: string, flipGreen: boolean, alpha: ChannelSpec): PackedTextureDef => ({
  suffix,
  label,
  r: src('normal', 'r', 0.5),
  g: src('normal', 'g', 0.5, flipGreen),
  b: src('normal', 'b', 1),
  a: alpha,
  srgb: false,
  mip: { alphaIsOpacity: false, rgbIsNormal: true },
});

/** The packer used by earlier versions is "legacy" = no packer (the glTF materials alone). */
export const LEGACY_PACKER = 'legacy';

export const PACKERS: readonly PackerDef[] = [
  {
    id: 'kekenik',
    label: 'Kekenik default',
    description: 'RGBA colour + opacity, RGB normal + A height, ORM (R ambient occlusion, G roughness, B metalness).',
    textures: [
      colorOpacity('basecolor', 'Colour (RGB) + Opacity (A)'),
      normalHeight('normal', 'Normal (RGB) + Height (A)', false, src('height', 'r', 1)),
      { suffix: 'orm', label: 'Occlusion (R) / Roughness (G) / Metalness (B)', r: src('ao', 'r', 1), g: src('roughness', 'r', 0.7), b: src('metallic', 'r', 0), a: c(1), srgb: false, mip: NO_MIP },
    ],
  },
  {
    id: 'unity-urp',
    label: 'Unity URP',
    description: 'BaseMap RGBA, OpenGL normal map, MetallicGloss (R metallic, A smoothness) and an occlusion map read from G.',
    textures: [
      colorOpacity('BaseMap', 'BaseMap: Colour (RGB) + Opacity (A)'),
      normalHeight('BumpMap', 'BumpMap: Normal (RGB) + Height (A)', false, src('height', 'r', 1)),
      { suffix: 'MetallicGloss', label: 'MetallicGlossMap: Metallic (R) / Smoothness (A)', r: src('metallic', 'r', 0), g: c(0), b: c(0), a: src('gloss', 'r', 0.3), srgb: false, mip: NO_MIP },
      { suffix: 'Occlusion', label: 'OcclusionMap: Occlusion (G)', r: c(1), g: src('ao', 'r', 1), b: c(1), a: c(1), srgb: false, mip: NO_MIP },
    ],
  },
  {
    id: 'unreal',
    label: 'Unreal',
    description: 'BaseColor + Opacity, DirectX (green flipped) normal + height, ORM (R occlusion, G roughness, B metallic).',
    textures: [
      colorOpacity('BaseColor', 'BaseColor (RGB) + Opacity (A)'),
      normalHeight('Normal', 'Normal DirectX (RGB) + Height (A)', true, src('height', 'r', 1)),
      { suffix: 'ORM', label: 'Occlusion (R) / Roughness (G) / Metallic (B)', r: src('ao', 'r', 1), g: src('roughness', 'r', 0.7), b: src('metallic', 'r', 0), a: c(1), srgb: false, mip: NO_MIP },
    ],
  },
];

export const PACKER_IDS: readonly string[] = [LEGACY_PACKER, ...PACKERS.map((p) => p.id)];

export function getPacker(id: string): PackerDef | undefined {
  return PACKERS.find((p) => p.id === id);
}
