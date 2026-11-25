import { buildCoverageMipChain } from '@/textures/alphaCoverage';
import { buildNormalMips } from '@/textures/normalMips';
import { createImage, fitSize, resizeImage, type RGBAImage } from '../images/imageOps';
import type { ChannelSpec, PackChannel, PackedTexture, PackedTextureDef, PackerDef, PackInputs, PackOptions, PackResult } from './types';

const CH: Record<PackChannel, number> = { r: 0, g: 1, b: 2, a: 3 };
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const SCALED = new Set(['ao', 'gloss', 'roughness', 'metallic']);

/** The roughness map is derived from the gloss map (and vice versa) so both names work in a packer definition. */
function sourceImage(inputs: PackInputs, source: NonNullable<ChannelSpec['source']>): { image: RGBAImage | undefined; invert: boolean } {
  const direct = inputs.images[source];
  if (direct) return { image: direct, invert: false };
  if (source === 'roughness') return { image: inputs.images.gloss, invert: true };
  if (source === 'gloss') return { image: inputs.images.roughness, invert: true };
  return { image: undefined, invert: false };
}

/** Constant of a channel without a map: the material slot scalar when there is one (roughness = 1 - gloss), else the spec value. */
function constantOf(spec: ChannelSpec, inputs: PackInputs): number {
  const s = spec.source;
  let v = spec.value;
  if (s) {
    const own = inputs.scalars[s];
    if (own !== undefined) v = own;
    else if (s === 'roughness' && inputs.scalars.gloss !== undefined) v = 1 - (inputs.scalars.gloss as number);
    else if (s === 'gloss' && inputs.scalars.roughness !== undefined) v = 1 - (inputs.scalars.roughness as number);
  }
  return clamp01(spec.invert ? 1 - v : v);
}

function scalarOf(spec: ChannelSpec, inputs: PackInputs): number {
  const s = spec.source;
  if (!s || !SCALED.has(s)) return 1;
  if (s === 'roughness' && inputs.images.roughness === undefined && inputs.scalars.gloss !== undefined) return inputs.scalars.gloss as number;
  return inputs.scalars[s] ?? 1;
}

/** True when the channel reads a pixel map. */
const hasMap = (spec: ChannelSpec, inputs: PackInputs): boolean => spec.source !== undefined && sourceImage(inputs, spec.source).image !== undefined;

/** Packs one texture. Returns the image, or the constants when every channel is constant. */
export function packTexture(def: PackedTextureDef, inputs: PackInputs, options: PackOptions): { image: RGBAImage; forced: boolean } | { constants: [number, number, number, number] } {
  const specs = [def.r, def.g, def.b, def.a] as const;
  const mapped = specs.some((s) => hasMap(s, inputs));
  if (!mapped) {
    const constants: [number, number, number, number] = [constantOf(def.r, inputs), constantOf(def.g, inputs), constantOf(def.b, inputs), constantOf(def.a, inputs)];
    if (!options.forceTextures) return { constants };
    const image = createImage(4, 4, [constants[0] * 255, constants[1] * 255, constants[2] * 255, constants[3] * 255]);
    return { image, forced: true };
  }
  let w = 1;
  let h = 1;
  for (const s of specs) {
    const img = s.source ? sourceImage(inputs, s.source).image : undefined;
    if (img) {
      w = Math.max(w, img.width);
      h = Math.max(h, img.height);
    }
  }
  if (options.maxSize > 0) ({ width: w, height: h } = fitSize(w, h, options.maxSize));
  const resized = new Map<RGBAImage, RGBAImage>();
  const fit = (img: RGBAImage): RGBAImage => {
    if (img.width === w && img.height === h) return img;
    let r = resized.get(img);
    if (!r) {
      r = resizeImage(img, w, h);
      resized.set(img, r);
    }
    return r;
  };
  const out = createImage(w, h, [0, 0, 0, 255]);
  specs.forEach((spec, k) => {
    const s = spec.source ? sourceImage(inputs, spec.source) : { image: undefined, invert: false };
    if (!s.image) {
      const v = Math.round(constantOf(spec, inputs) * 255);
      for (let i = 0; i < w * h; i++) out.data[i * 4 + k] = v;
      return;
    }
    const img = fit(s.image);
    const ch = CH[spec.channel ?? 'r'];
    const mul = scalarOf(spec, inputs);
    for (let i = 0; i < w * h; i++) {
      let v = ((img.data[i * 4 + ch] as number) / 255) * mul;
      if (s.invert) v = 1 - v;
      if (spec.invert) v = 1 - v;
      out.data[i * 4 + k] = Math.round(clamp01(v) * 255);
    }
  });
  return { image: out, forced: false };
}

/** Mip chain honouring the def's flags (AlphaIsOpacity keeps the alpha-test coverage, RgbIsNormal averages vectors). */
export function buildMips(def: PackedTextureDef, image: RGBAImage, alphaCutoff: number): RGBAImage[] {
  if (def.mip.rgbIsNormal) return buildNormalMips(image);
  if (def.mip.alphaIsOpacity) {
    const chain = buildCoverageMipChain({ width: image.width, height: image.height, data: new Uint8Array(image.data) }, { channel: 'a', cutoff: alphaCutoff });
    return chain.map((m) => ({ width: m.width, height: m.height, data: new Uint8ClampedArray(m.data) }));
  }
  const chain: RGBAImage[] = [image];
  let cur = image;
  while (cur.width > 1 || cur.height > 1) {
    cur = resizeImage(cur, Math.max(1, cur.width >> 1), Math.max(1, cur.height >> 1));
    chain.push(cur);
  }
  return chain;
}

export function runPacker(packer: PackerDef, inputs: PackInputs, options: PackOptions): PackResult {
  const result: PackResult = { packer: packer.id, textures: [], constants: {} };
  for (const def of packer.textures) {
    const r = packTexture(def, inputs, options);
    if ('constants' in r) {
      result.constants[def.suffix] = r.constants;
      continue;
    }
    const tex: PackedTexture = { suffix: def.suffix, label: def.label, srgb: def.srgb, image: r.image, mips: buildMips(def, r.image, options.alphaCutoff), forced: r.forced };
    result.textures.push(tex);
  }
  return result;
}
