import type { DisplacementChannel, DisplacementDef } from '@/contracts/material';

/** Raw decoded RGBA8 source image (registered by the texture manager once the asset is decoded). */
export interface DisplacementSource {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** Processed height field, values 0..1. */
export interface HeightField {
  width: number;
  height: number;
  data: Float32Array;
}

export const DISPLACEMENT_CHANNELS: { value: DisplacementChannel; label: string }[] = [
  { value: 'greyscale', label: 'Greyscale' },
  { value: 'luminance', label: 'Luminance' },
  { value: 'r', label: 'R' },
  { value: 'g', label: 'G' },
  { value: 'b', label: 'B' },
  { value: 'a', label: 'A' },
];

export function createDisplacementDef(id: string, name: string): DisplacementDef {
  return { id, name, assetId: '', fileName: '', channel: 'greyscale', smoothing: 0, brightness: 0.5, contrast: 0.5, normalize: true };
}

function extract(src: DisplacementSource, channel: DisplacementChannel): Float32Array {
  const n = src.width * src.height;
  const out = new Float32Array(n);
  const p = src.rgba;
  for (let i = 0; i < n; i++) {
    const r = (p[i * 4] as number) / 255;
    const g = (p[i * 4 + 1] as number) / 255;
    const b = (p[i * 4 + 2] as number) / 255;
    const a = (p[i * 4 + 3] as number) / 255;
    out[i] =
      channel === 'r' ? r : channel === 'g' ? g : channel === 'b' ? b : channel === 'a' ? a : channel === 'luminance' ? 0.2126 * r + 0.7152 * g + 0.0722 * b : (r + g + b) / 3;
  }
  return out;
}

/** Separable box blur with wrap-around edges (tileable, so seams stay invisible). */
export function blurWrap(data: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return data;
  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  const k = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += data[y * w + ((x + d + w * 4) % w)] as number;
      tmp[y * w + x] = s / k;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let d = -radius; d <= radius; d++) s += tmp[((y + d + h * 4) % h) * w + x] as number;
      out[y * w + x] = s / k;
    }
  }
  return out;
}

/** channel -> smoothing -> brightness/contrast (0.5 = neutral) -> optional normalise to the full 0..1 range. */
export function processDisplacement(def: DisplacementDef, src: DisplacementSource): HeightField {
  let data = extract(src, def.channel);
  data = blurWrap(data, src.width, src.height, Math.round(Math.min(1, Math.max(0, def.smoothing)) * 8));
  const out = new Float32Array(data.length);
  const offset = def.brightness - 0.5;
  const gain = Math.max(0, def.contrast) * 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = Math.min(1, Math.max(0, ((data[i] as number) + offset - 0.5) * gain + 0.5));
    out[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (def.normalize && hi - lo > 1e-6) for (let i = 0; i < out.length; i++) out[i] = ((out[i] as number) - lo) / (hi - lo);
  return { width: src.width, height: src.height, data: out };
}

const sources = new Map<string, DisplacementSource>();
const sourceRevision = new Map<string, number>();
const processed = new Map<string, HeightField>();
const mipChains = new Map<string, HeightField[]>();
const listeners = new Set<() => void>();

export function registerDisplacementSource(assetId: string, src: DisplacementSource): void {
  sources.set(assetId, src);
  sourceRevision.set(assetId, (sourceRevision.get(assetId) ?? 0) + 1);
  for (const key of [...processed.keys()]) if (key.startsWith(`${assetId}|`)) processed.delete(key);
  for (const key of [...mipChains.keys()]) if (key.startsWith(`${assetId}|`)) mipChains.delete(key);
  listeners.forEach((l) => l());
}

export const hasDisplacementSource = (assetId: string): boolean => sources.has(assetId);
export function onDisplacementSourcesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const keyOf = (d: DisplacementDef): string => `${d.assetId}|${d.channel}|${d.smoothing}|${d.brightness}|${d.contrast}|${d.normalize}`;

/**
 * Text that changes whenever the processed height field of `def` would change (settings or decoded image).
 * Used as the cache key extra of nodes that displace geometry, so only those nodes re-evaluate.
 */
export const displacementStamp = (d: DisplacementDef): string => `${keyOf(d)}@${sourceRevision.get(d.assetId) ?? 0}`;

/** Processed (cached) height field of a displacement, or null while its image is not decoded. */
export function getHeightField(def: DisplacementDef): HeightField | null {
  const src = sources.get(def.assetId);
  if (!src) return null;
  const key = keyOf(def);
  let hf = processed.get(key);
  if (!hf) {
    hf = processDisplacement(def, src);
    if (processed.size > 16) processed.clear();
    processed.set(key, hf);
  }
  return hf;
}

/** Box-filtered 2x down-sampling with wrap-around (images of odd size lose the last row/column). */
export function downsampleField(hf: HeightField): HeightField {
  const w = Math.max(1, hf.width >> 1);
  const h = Math.max(1, hf.height >> 1);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(hf.width - 1, x * 2);
      const y0 = Math.min(hf.height - 1, y * 2);
      const x1 = Math.min(hf.width - 1, x0 + 1);
      const y1 = Math.min(hf.height - 1, y0 + 1);
      data[y * w + x] = ((hf.data[y0 * hf.width + x0] as number) + (hf.data[y0 * hf.width + x1] as number) + (hf.data[y1 * hf.width + x0] as number) + (hf.data[y1 * hf.width + x1] as number)) / 4;
    }
  }
  return { width: w, height: h, data };
}

/** Mip chain of the processed height field (level 0 = full resolution); null while the image is not decoded. */
export function getHeightMips(def: DisplacementDef): HeightField[] | null {
  const base = getHeightField(def);
  if (!base) return null;
  const key = keyOf(def);
  let chain = mipChains.get(key);
  if (!chain) {
    chain = [base];
    while ((chain[chain.length - 1] as HeightField).width > 1 && (chain[chain.length - 1] as HeightField).height > 1 && chain.length < 12) {
      chain.push(downsampleField(chain[chain.length - 1] as HeightField));
    }
    if (mipChains.size > 16) mipChains.clear();
    mipChains.set(key, chain);
  }
  return chain;
}

/** Trilinear sample: bilinear in two neighbouring mips blended by the fractional `level` (0 = full resolution). */
export function sampleHeightMips(chain: readonly HeightField[], u: number, v: number, level: number): number {
  const l = Math.min(chain.length - 1, Math.max(0, level));
  const l0 = Math.floor(l);
  const l1 = Math.min(chain.length - 1, l0 + 1);
  const a = sampleHeightField(chain[l0] as HeightField, u, v);
  if (l1 === l0) return a;
  const b = sampleHeightField(chain[l1] as HeightField, u, v);
  return a + (b - a) * (l - l0);
}

/** Bilinear, wrapping sample of the processed height field at (u, v) (any real numbers). Returns 0 without an image. */
export function sampleDisplacement(def: DisplacementDef, u: number, v: number): number {
  const hf = getHeightField(def);
  return hf ? sampleHeightField(hf, u, v) : 0;
}

export function sampleHeightField(hf: HeightField, u: number, v: number): number {
  const fx = (u - Math.floor(u)) * hf.width - 0.5;
  const fy = (v - Math.floor(v)) * hf.height - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (x: number, y: number): number => hf.data[((y + hf.height) % hf.height) * hf.width + ((x + hf.width) % hf.width)] as number;
  const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}
